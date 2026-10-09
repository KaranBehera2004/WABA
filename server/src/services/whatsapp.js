import { Contact, Conversation, Message } from '../models/Domain.js';
import { assertConfigured, buildPayload, createSmartpingClient, SmartpingError, validateTemplate } from './smartping.js';
import { checkSendingPolicy } from './platform.js';
import { createWithCapacity } from './capacity.js';
import { persistMeteredMessage, refundRejectedMessage, settleMessageCharge } from './wallet.js';
import { settledRecordCharges } from './walletReceipts.js';
import { WhatsAppNumber } from '../models/Business.js';
import { configuration, phoneNumber } from './smartping.js';

const client = createSmartpingClient();
const walletBilling = { persist: persistMeteredMessage, settle: settleMessageCharge, refund: refundRejectedMessage };
export async function checkSendingNumber(workspace, conversation) {
  const number = await WhatsAppNumber.findOne({ workspace, ...(conversation.number ? { _id: conversation.number } : { provider: 'smartping', phone: configuration().from }) });
  if (conversation.number && !number || number && (number.disconnectedAt || number.provider !== 'smartping' || number.phone !== configuration().from)) throw new SmartpingError('The sending number is disconnected or is not the configured Smartping number.', 409);
}
export async function checkSmartpingAuthentication(workspace) {
  assertConfigured(workspace);
  if (process.env.SMARTPING_AUTH_TOKEN) return { authenticated: false, message: 'Authentication token is configured. This document has no token-verification endpoint; validity is checked when sending a template.' };
  await client.login();
  return { authenticated: true, message: 'Smartping login succeeded. No message was sent.' };
}
export async function sendTemplate({ workspace, conversation, sender, template, metaData, idempotencyKey, campaign, providerClient = client, policyChecker = checkSendingPolicy, billing = walletBilling }) {
  assertConfigured(workspace);
  if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9:._-]{8,160}$/.test(idempotencyKey)) throw new SmartpingError('A unique request key is required.');
  const validated = validateTemplate(template);
  // Wait for the unique request-key index before allowing concurrent dispatches.
  await Message.init();
  const previous = await Message.findOne({ workspace, idempotencyKey });
  if (previous) {
    if (String(previous.conversation) !== String(conversation._id) || JSON.stringify(previous.templatePayload) !== JSON.stringify(validated)) throw new SmartpingError('Request key already belongs to a different message.', 409);
    return { item: previous, duplicate: true, walletCharges: [] };
  }
  await policyChecker(workspace, { broadcast: Boolean(campaign) });
  await checkSendingNumber(workspace, conversation);
  const contact = await Contact.findOne({ _id: conversation.contact, workspace });
  if (!contact) throw new SmartpingError('Customer not found in this workspace.', 404);
  if (!contact.subscribed || contact.optOutAt || contact.archivedAt || !contact.optInAt || !contact.optInSource || !Number.isFinite(+new Date(contact.optInAt)) || +new Date(contact.optInAt) > Date.now()) throw new SmartpingError('This customer has opted out or has no recorded WhatsApp consent.', 409);
  const optOuts=await Contact.find({workspace,$or:[{subscribed:false},{optOutAt:{$ne:null}}]}).select('phone').lean();
  if(optOuts.some(item=>{try{return phoneNumber(item.phone)===phoneNumber(contact.phone);}catch{return false;}}))throw new SmartpingError('An opted-out duplicate of this number exists in this business. Review consent before sending.',409);
  let item = new Message({ workspace, conversation: conversation._id, number: conversation.number, sender, direction: 'outbound', type: 'template', body: 'Template: ' + validated.templateId, provider: 'smartping', templatePayload: validated, metaData, idempotencyKey, campaign, status: 'queued' });
  const payload = buildPayload({ workspaceId: workspace, messageId: item._id, to: contact.phone, template: validated, metaData });
  try { item = await billing.persist(item); } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await Message.findOne({ workspace, idempotencyKey });
    if (!existing) throw error;
    if (String(existing.conversation) !== String(conversation._id) || JSON.stringify(existing.templatePayload) !== JSON.stringify(validated)) throw new SmartpingError('Request key conflict.', 409);
    return { item: existing, duplicate: true, walletCharges: [] };
  }
  let providerAccepted = false;
  try {
    const accepted = await providerClient.send(payload);
    providerAccepted = true;
    // A delivery callback may arrive before the send response. Preserve that status.
    const saved = await Message.updateOne({ _id: item._id, workspace, $or: [{ providerMessageId: { $exists: false } }, { providerMessageId: accepted.id }] }, { $set: { providerMessageId: accepted.id } });
    if (!saved.matchedCount) throw new SmartpingError('Provider message ID could not be correlated. Check Smartping reports before retrying.', 502, true);
    await billing.settle(workspace, item._id);
    await Conversation.updateOne({ _id: conversation._id, workspace }, { $set: { lastMessage: item.body, lastMessageAt: item.createdAt } });
    return { item: await Message.findById(item._id), duplicate: false, walletCharges: settledRecordCharges(item) };
  } catch (error) {
    await Message.updateOne({ _id: item._id, workspace, status: 'queued', providerEventAt: { $exists: false } }, { $set: { status: error.uncertain || !(error instanceof SmartpingError) ? 'unknown' : 'failed', error: { message: error instanceof SmartpingError ? error.message : 'Unable to record Smartping acceptance. Check provider delivery reports before retrying.' } } });
    // Never refund a timeout or an accepted request: it may already have reached the customer.
    if (!providerAccepted && error instanceof SmartpingError && !error.uncertain) {
      try { await billing.refund(workspace, item._id); }
      catch { throw new SmartpingError('The provider rejected this request, but its test wallet refund needs administrator review. Do not resend automatically.', 502, true); }
    }
    if (!(error instanceof SmartpingError)) throw new SmartpingError('Unable to confirm the saved provider response. Check Smartping reports before retrying.', 502, true);
    throw error;
  }
}

export async function conversationForContact(workspace, contactId, sender, req) {
  let conversation = await Conversation.findOne({ workspace, contact: contactId, status: { $ne: 'closed' } });
  if (!conversation) {
    const payload = { workspace, contact: contactId, assignedTo: sender };
    conversation = req ? await createWithCapacity(req, 'conversations', Conversation, payload) : await Conversation.create(payload);
  }
  return conversation;
}
