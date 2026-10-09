# Business Admin implementation — WABA

Updated 8 October 2026. This extends the existing React/TypeScript/Vite client and Express/Mongoose backend. JustConnect-CRM was not modified; SHA-256 verification covered 661 protected files.

## Implemented business workflows

- Only Business Admin and Agent are assignable business roles. The internal owner maps to Business Admin. Platform Super Admin remains separate. Retired memberships have no access, including when old custom permissions exist; reassignment requires an explicit Admin action.
- Database-authoritative authentication, session revocation, business-scoped routes, conversation/contact/message/file ownership checks, hard Agent permission ceilings, and selected-team read visibility with primary-assignee-only writes. There is no real-time transport in the existing stack; scoped polling is used.
- Distinct Admin overview and Agent work desk. Admin metrics, date and number filters, inbox drill-downs, response samples, Agent workload/availability, campaign receipts and test-wallet usage use stored records.
- Users and teams, secure one-use invitation/password links, link rotation, existing-account membership, number permissions, capacity, availability, disabled access, session-version revocation and unassignment of active chats. Last active Business Admin protection runs inside a business transaction.
- Atomic manual, round-robin, least-workload, team routing and optional claiming. Transactions serialize on the business document; conversations use version comparisons. Availability, active accounts, number/team mapping and capacity constrain routing. No eligible Agent leaves a chat unassigned.
- Inbox queues, search, Agent/team/number/tag/date/status filtering and pagination; internal notes, activity, assignment, takeover notifications, tags, configured resolution reasons, open/pending/resolved/reopen and approved-template sending. Team-visible conversations remain read-only for other Agents.
- Contacts with normalized business-unique phones, owners, configured custom fields, tags, segments, consent evidence, opt-outs, history and notes. CSV parsing handles quoted fields, preview, validation, duplicate skip/update and ambiguous legacy duplicates. Imports never override existing consent. Admin exports, archive and confirmed deletion are backend-protected.
- Shared quick replies with supported variables and team scope; tag creation, archive and transactional rename of contact/conversation/segment labels.
- Template drafts, components, samples, preview, Smartping media mapping and Meta management submission/synchronization. Approval comes only from provider responses; edits require renewed approval. Synchronization follows provider pagination.
- Campaign drafts, editing, contact/segment audiences, variable mapping, consent/duplicate exclusions, preview, explicitly confirmed single-contact tests, final launch confirmation, scheduling, pause/resume/cancel, durable recipient jobs, receipt reports and bounded retries of confirmed eligible failures. Uncertain sends never retry automatically.
- Versioned journeys with approved messages, business hours (including overnight hours), holidays, keywords/menu configuration, conditions, delays, assignment, handoff, webhook actions, field-collection configuration, dry-run tests, publishing/toggling, explicit enrollment and execution logs. Human takeover pauses bot actions.
- Conversation, Agent/team, campaign, template, automation and usage CSV reports; business settings; number/team/default mapping; encrypted integration credentials, signed webhook subscriptions, field mapping, connection tests, delivery logs/retries; own active-session management; notifications and audit logs.
- Responsive existing visual style, loading/error/empty states, labelled forms, focus-trapped dialogs, confirmation and pagination. Business branding uses the workspace name and retains the requested navigation spacing.

## Provider and infrastructure dependencies

These are visible as unavailable/configuration-required states, not simulated results:

| Capability | Current dependency |
| --- | --- |
| Live template/media messages and delivery receipts | Business-bound Smartping sender/credentials, valid provider-approved template mapping, signed callback configuration and sufficient existing test-wallet credits. Media uses the existing provider-supported template payload; native file upload/free-form attachment transport is not implemented without the provider contract. |
| Free-text inbox replies; native inbound capture; automatic welcome/away/keyword/menu triggers; interactive contact-field collection | Smartping free-text/media and inbound webhook contracts are absent from the supplied integration. The 24-hour rule is enforced; unsupported requests return an explicit error. Collection steps stop with a dependency result, rather than fabricating a customer response. Automatic triggers are not claimed to run. |
| Provider template submission/approval, number quality/verification synchronization | Configure business-specific Meta management credentials, WABA ID and a supported Graph API version. These operations have not been live-tested against Meta credentials. Smartping does not expose these management endpoints in its supplied contract. |
| Embedded onboarding; provider profile edits and registration disconnect/reconnect | Existing provider console/onboarding is required. CRM number disconnect/reconnect controls local routing/sending only and never claim to change registration/verification. Provider business-profile update transport is not implemented without the required verified provider contract. |
| Invitation delivery | Secure one-use links work. Automatic email delivery needs a configured mail service; the Admin receives a private manual-delivery link. |
| Integration credential storage | Set BUSINESS_ENCRYPTION_KEY to a securely generated base64 32-byte key. AES-256-GCM binds credentials to the business. Keep the key outside source control and retain it when rotating provider credentials. |
| CRM webhook execution | Set BUSINESS_WEBHOOK_ALLOWED_HOSTS, configure an encrypted signing secret, and explicitly run the production worker. DNS-pinned HTTPS rejects private network destinations and redirects. |
| Live campaigns/journeys | Explicit production worker activation, provider credentials and validated data are required. The API never starts the worker. |
| Recharge, real payments and provider invoices/costs | Payment gateway/production billing integration is unavailable. Existing plan, test-wallet transactions and platform invoices are shown accurately. Estimates and confirmed provider costs are unavailable rather than fabricated. |

The existing Smartping adapter remains the messaging transport; Meta configuration is management-only. No real customer campaign or journey was sent during implementation or verification. No credentials were invented.

## Metrics

Conversation totals/status/unread counts select conversations whose latest activity (or creation when no message exists) falls within [from, to), also honoring the number filter. Unassigned excludes resolved chats. Open, Pending and Resolved map to the existing stored open, awaiting_reply and closed statuses. Unread is a message count, not a chat count.

First response is the mean first confirmed human reply delay per conversation, paired from the oldest unanswered inbound message. Average response is the mean of all recorded inbound-to-confirmed-human-reply pairs whose reply lies in the selected period. Failed, queued, unknown and bot messages are excluded. No samples returns null, not a fabricated zero. Workload counts currently unresolved assignments independent of dates. Delivery counts are cumulative: Read also counts as Delivered and Sent. Acceptance alone is not delivery. Campaign reply reports show recorded inbound replies in the same conversation after a campaign send; they do not imply provider-level campaign attribution. Usage amounts are explicitly INR test credits.

## Migration

From WABA/server:

```powershell
node src/scripts/migrateBusinessAdmin.js
node src/scripts/migrateBusinessAdmin.js --apply
```

Dry run is the default and disables automatic index creation. Apply preserves original phone values, duplicate records, consent and statuses; it normalizes only unambiguous phones, blocks retired memberships and revokes their sessions, adds Sales/Support and existing tag definitions, and initializes conversation versions. It creates the partial business/normalized-phone unique index. It creates the workspace/name/language template index before dropping the old name-only constraint. No records are merged or deleted and no retired role is promoted.

The migration was applied to the current development database: 1 business, 0 contact records and 0 previously enabled retired memberships requiring changes. A subsequent dry run completed successfully. Existing business users and data were preserved.

## Worker operation

API/dev startup never starts outbound processing. To run live jobs, the server operator must deliberately set both NODE_ENV=production and ENABLE_OUTBOUND_JOBS=true, then run:

```powershell
node src/scripts/businessWorker.js --allow-live-sends
```

Do not activate this against development or test customers. Pending work is inert until all three conditions are met. Review provider configuration and queued jobs before a production operator activates it. Per-business job keys and message keys deduplicate sends; expired leases become uncertain and require review. Consent, template status, connection and actor access are rechecked during execution. Cancellation affects pending work; accepted messages cannot be recalled.

## Verification evidence

- 237 backend tests passed; 56 client tests passed; TypeScript noEmit and Vite production build passed. The existing bundle-size advisory remains (approximately 588 KB JS before gzip).
- HTTP/model tests cover foreign business rejection, Agent administration/export/billing restrictions, unauthorized conversations and numbers, selected-team read-only access, disabled/revoked users, retired-role rejection, local-only notes and foreign report-file denial.
- Transaction/CAS tests cover competing claims, last-slot capacity, no-eligible routing, last-Admin policy and campaign launch deduplication/consent exclusions. These database models are substituted for deterministic tests; they are not a claim of live multi-process Mongo/provider load testing.
- 17 authenticated read-only routes returned HTTP 200 against the running local API/current database. No customer records, credentials or tokens were printed by the smoke script.
- Isolated Playwright layout fixtures checked all 16 Admin sections at 1440, 820 and 390 px, six mobile dialogs, the two-role selector and separate Agent navigation at all three widths. No page errors or horizontal document overflow were observed. Fixture screenshots are layout previews, not live integration evidence.
- SHA-256 comparison found no changes among 661 checked JustConnect-CRM files.

Commands:

```powershell
# server
node --test src/services/*.test.js src/routes/*.test.js
node src/scripts/checkBusinessAdmin.js
# client
node --test tests/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
```

## Official references checked

- [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/) — customer consent, opt-outs, approved business-initiated templates, the 24-hour service window and escalation.
- [Meta-owned Business SDK: WhatsApp Business Account](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/whatsappbusinessaccount.py) — account-scoped template and number management operations.
- [Meta-owned Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api) — account/number prerequisites, management permissions and pagination.
- [Meta-owned Get Business Profile request](https://www.postman.com/meta/whatsapp-business-platform/request/i21qxwn/get-business-profile) — profile synchronization for a number returned by this business's Meta management account. Only provider-returned fields are displayed; profile editing remains unavailable.
- [Smartping](https://waba.smartping.io/) and the supplied [SMARTPING.md](SMARTPING.md) contract — existing template sends, login and signed delivery callbacks. Unsupported APIs were not invented.

## Source-file review manifest

This manifest includes the WABA changes from the role/UI work in this conversation and this Business Admin extension. Generated build files and QA screenshots are excluded.

- `client/src/App.tsx`
- `client/src/business.css`
- `client/src/components/AgentAvailability.tsx`
- `client/src/components/BusinessModule.tsx`
- `client/src/components/BusinessNotifications.tsx`
- `client/src/components/BusinessOperations.tsx`
- `client/src/components/CallLogs.tsx`
- `client/src/components/ChatInbox.tsx`
- `client/src/components/ConversationTools.tsx`
- `client/src/components/CreateAccountModal.tsx`
- `client/src/components/CreateWorkspaceModal.tsx`
- `client/src/components/CustomerSegments.tsx`
- `client/src/components/DemoModules.tsx`
- `client/src/components/InvitationSetup.tsx`
- `client/src/components/SmartpingComposer.tsx`
- `client/src/components/SmartpingConnection.tsx`
- `client/src/lib/accountCreate.ts`
- `client/src/lib/api.ts`
- `client/src/lib/navigation.ts`
- `client/src/lib/workspaceAccess.ts`
- `client/src/lib/WorkspaceAccessContext.tsx`
- `client/src/lib/workspaceCreate.ts`
- `client/src/main.tsx`
- `client/src/pages/AdminOperations.tsx`
- `client/src/pages/Dashboard.tsx`
- `client/src/pages/dashboards/AgentDashboard.tsx`
- `client/src/pages/dashboards/BusinessAdminDashboard.tsx`
- `client/src/pages/dashboards/BusinessDashboard.tsx`
- `client/src/pages/dashboards/shared.tsx`
- `client/src/pages/RoleOverview.tsx`
- `client/src/pages/SuperAdmin.tsx`
- `client/src/pages/TestWallet.tsx`
- `client/src/professional.css`
- `client/tests/accountCreate.test.mjs`
- `client/tests/workspaceAccess.test.mjs`
- `client/tests/workspaceCreate.test.mjs`
- `README.md`
- `server/.env.example`
- `server/package.json`
- `server/src/app.js`
- `server/src/middleware/auth.js`
- `server/src/middleware/businessAudit.js`
- `server/src/middleware/workspace.js`
- `server/src/models/Business.js`
- `server/src/models/Domain.js`
- `server/src/models/Workspace.js`
- `server/src/routes/auth.js`
- `server/src/routes/business.js`
- `server/src/routes/businessAutomations.js`
- `server/src/routes/businessCampaigns.js`
- `server/src/routes/businessCampaigns.test.js`
- `server/src/routes/businessReports.js`
- `server/src/routes/businessSecurity.test.js`
- `server/src/routes/businessSettings.js`
- `server/src/routes/conversations.js`
- `server/src/routes/dashboardRoles.test.js`
- `server/src/routes/data.js`
- `server/src/routes/platformPolicy.test.js`
- `server/src/routes/smartping.js`
- `server/src/routes/superadmin.js`
- `server/src/routes/superadminOperations.js`
- `server/src/routes/superadminOperations.test.js`
- `server/src/routes/superadminUser.test.js`
- `server/src/routes/workspaceBusiness.test.js`
- `server/src/routes/workspaces.js`
- `server/src/scripts/businessWorker.js`
- `server/src/scripts/checkBusinessAdmin.js`
- `server/src/scripts/migrateBusinessAdmin.js`
- `server/src/services/accessControl.js`
- `server/src/services/accessControl.test.js`
- `server/src/services/assignment.js`
- `server/src/services/assignment.test.js`
- `server/src/services/businessAdmin.test.js`
- `server/src/services/businessAutomations.js`
- `server/src/services/businessContacts.js`
- `server/src/services/businessIntegrations.js`
- `server/src/services/businessJobs.js`
- `server/src/services/businessMetrics.js`
- `server/src/services/businessPolicy.js`
- `server/src/services/businessSecrets.js`
- `server/src/services/superadminUser.js`
- `server/src/services/superadminUser.test.js`
- `server/src/services/webhookTransport.js`
- `server/src/services/whatsapp.js`
- `server/src/services/whatsapp.test.js`
- `server/src/services/workspaceBusiness.test.js`
- `server/src/services/workspaceConfig.js`
- `server/src/services/workspaceConfig.test.js`
- `server/SUPERADMIN.md`

