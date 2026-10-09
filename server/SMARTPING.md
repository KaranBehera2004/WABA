# Smartping WhatsApp integration

The server supports the documented Smartping enterprise login, template-message send endpoint, and delivery-report callback events. It does not claim a message is delivered when Smartping only acknowledges accepting it.

## Server configuration

Copy these values into `server/.env`. Keep every credential on the server; do not use `VITE_` variables.

| Setting | Purpose |
| --- | --- |
| `SMARTPING_WORKSPACE_ID` | MongoDB ID of the one WABA workspace allowed to use this Smartping account. |
| `SMARTPING_JOURNEY_ID` | Journey ID supplied by Smartping. |
| `SMARTPING_FROM` | Sender phone number with country code. |
| `SMARTPING_DEPT_ID` | Optional department ID. |
| `SMARTPING_LOGIN_URL` | Exact HTTPS account host plus `/account/enterprise/login`, as provided by Smartping. The PDF does not state the host. |
| `SMARTPING_EMAIL`, `SMARTPING_PASSWORD` | Server-side Smartping login credentials; use these or the static token option. |
| `SMARTPING_AUTH_TOKEN` | Optional server-side token instead of login credentials. The document does not describe a token verification route. |
| `SMARTPING_CALLBACK_BASE_URL` | Optional public HTTPS origin of this WABA API, with no path. It must be reachable by Smartping. |
| `SMARTPING_WEBHOOK_SECRET` | Random secret of at least 32 characters used to authenticate callbacks because the document specifies no signature header. |

After setting `SMARTPING_WORKSPACE_ID`, restart the API. In Manage channels, refresh configuration and use Test authentication. That button only checks account login when email/password login is configured; with a static token it clearly reports that token validity can only be checked by a send response.

Without `SMARTPING_CALLBACK_BASE_URL` and `SMARTPING_WEBHOOK_SECRET`, the app can submit template sends but cannot receive delivery-status updates. Set both values together. The callback URL is unique to a saved message and contains an HMAC token. Callback requests are excluded from request logs so the token is not recorded there.

## Configure a template

Create the local template record, then open it in Templates and enter the Smartping `templateId` and any fields used by its approved template. This stores the payload for reuse; it does not submit a template to Meta or certify its approval. Smartping remains authoritative and can reject a mismatched ID or parameters.

Supported documented fields include `templateUId`, zero-based string `parameterValues` and `headerParameterValues`, `media` with `IMAGE`, `DOC`, or `VIDEO`, URL and quick-reply buttons, authentication copy-code buttons, and carousel cards. Carousel cards support `IMAGE` or `VIDEO` media and up to two buttons per card. Example object:

```json
{
  "templateId": "approved_template_name",
  "parameterValues": { "0": "Asha" },
  "headerParameterValues": { "0": "Welcome" }
}
```

## Send and delivery behavior

Inbox replies use the saved template composer; free-text messages are rejected. Campaign sends require selecting 1–100 opted-in contacts in this workspace. Sending uses the documented endpoint at `https://waba.smartping.io/chatbird/api/message/send` and sends `authentication-token` as a header, without a Bearer prefix. No sample PDF phone number is ever used as a recipient.

Smartping's `status: true`, `code: 100`, and provider message ID mean accepted. `SENT`, `DELIVERED`, `READ`, and `FAILED` callback events update the stored message. Callback IDs are checked against the workspace and message. Duplicate or older events cannot downgrade a later delivery state. Every send carries a stable local idempotency key; after a timeout or uncertain result the UI prevents resending the same request. Check Smartping's Delivery Report before deciding what to do next.

Campaign sends are currently initiated manually; there is no background scheduler or automatic campaign resume. If a campaign stops part way through, inspect its individual message statuses and Smartping reports before sending anything else.

The supplied document gives no REST endpoints for inbound WhatsApp messages, template listing or approval, delivery-report retrieval, Meta Ads, or automation triggers. Those features require the corresponding provider documentation before their APIs can be integrated.
