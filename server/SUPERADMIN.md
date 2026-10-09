# WABA superadmin

This panel belongs to WABA only. JustConnect-CRM was read as a reference and was not modified.

## Delete users and workspaces

Under **Users** or **Workspaces**, use a row's **Delete** button, select checkboxes and choose **Delete selected**, or choose **Delete all**. Delete all covers every page, regardless of the current search. Review the preview and type its exact confirmation phrase before submitting.

Deletion archives records and removes active access; it does not permanently erase business records, invoices or wallet history. Workspace deletion stops sending and pauses running campaigns without deleting its users. Account deletion revokes sign-in sessions and removes memberships and assignments. The signed-in superadmin, last active superadmin, and owners of undeleted workspaces are protected. Transfer ownership or delete the workspace first to delete its owner account.

Previews expire after ten minutes and include only the displayed snapshot, never accounts created later. Selected batches allow 200 records; delete-all previews allow 1000 and explicitly reject larger operations. Archived email addresses/business identifiers remain reserved. There is no restore screen. After an uncertain network result, refresh the preview instead of blindly repeating deletion.

## Give your account access

1. Register your own account in WABA, or use an existing active registered account.
2. Open a terminal in the `WABA/server` folder. The server's `.env` must already contain the WABA MongoDB connection and JWT settings.
3. Run this command, replacing the example email with your registered email:

   ```powershell
   npm run create-superadmin -- --email your-email@example.com
   ```

4. Restart the WABA server and client if they are still running an older version. From the `WABA` folder, run `npm run dev`.
5. Sign out, then sign in with that email and your existing password. WABA opens the Superadmin panel automatically.

The command does not create a new password or pick an account automatically. It grants platform-level access to the selected existing active account and revokes its old sessions. Keep this access limited to trusted platform administrators. Do not put passwords or provider tokens in command arguments or chat.

## Controls

- **Overview:** Real account, workspace and stored activity totals; database state, provider readiness and recent administrator activity.
- **Workspaces:** Workspace rows show **Manage** and **Delete**. Open Manage for business settings, access, members, permissions, custom plans and workspace entry. Create workspaces, assign an owner, suspend/reactivate access, pause sending, assign a plan, set an expiry and disable individual features. Private admin notes are excluded from normal workspace responses.
- **Members:** Add/remove registered accounts, change workspace roles and transfer ownership. Exactly one active owner is required. Account-level roles and workspace membership roles are separate.
- **Open workspace:** Inspect any workspace using your own superadmin identity. This is explicit workspace-scoped access, not impersonation. Use the return button to go back to the panel. Browser back/forward and refresh preserve navigation.
- **Users:** Business rows start collapsed. Click the arrow or business row to show only its linked accounts. Memberships determine grouping; a company profile label or stale default workspace never adds business access. Accounts belonging to several businesses appear in each membership, while platform accounts and unlinked accounts have separate groups. Search matches business names or account names/emails, with pagination for business groups and large member lists. Existing edit, password reset, deletion and export controls remain available. Create accounts with an existing business selection, create a new business and its owner together, or explicitly create a platform superadmin. Password changes, deactivation and role changes revoke existing sessions. You cannot demote/suspend yourself, and the final active superadmin cannot be removed.
- **Workspace data:** Inspect records in a selected workspace; create/edit supported fields for contacts, conversations, calls, campaigns, templates, bots, dashboards, segments and stored ads. Advanced edits use validated JSON. Deletions require confirmation and reject protected relationships. Message delivery statuses and generated reports are not editable.
- **Plans:** Set feature entitlements and reference monthly prices. Assign plans separately to workspaces. Archiving a plan stops new assignment; it does not cancel existing subscriptions. Subscription dates and invoices are managed explicitly; there is no automatic recurring billing.
- **Billing:** Create invoices and record externally confirmed payments. Use **Download PDF** beside each invoice's status button to save its current invoice details, workspace, dates, total and any recorded payment reference. Draft and void PDFs are clearly marked as not payable. Downloads are superadmin-only, audited and do not change invoice status or wallet balance. A paid invoice requires a payment reference; paid invoices can only be voided, and void invoices are immutable. No card is charged by this screen.
- **Wallet & pricing:** Manage separate TEST wallets, activity prices, one-time opening credits, charging enable/disable, administrator adjustments and business transaction history. These dummy INR credits are not customer funds, provider costs, or real payments.

  Business users can open the wallet beside the theme toggle and use **Demo activity tester** to run one chat-message, call, campaign or other simulated activity. It deducts the current configured test price and shows the deducted amount, remaining balance and a demo-labelled ledger entry. No message is sent, call placed or provider/business record created. Activity permissions and disabled features still apply. Retrying the same request cannot deduct twice; paused deductions and zero prices do not debit credits. Normal committed chargeable activities also show a deduction notice and update the header balance.
- **Integrations:** View Smartping readiness, bound workspace, sender, journey and callback status without exposing tokens or passwords. Credentials remain configured on the server; setup can be completed later.
- **Audit:** Read administrator mutation history. Successful writes record the administrator, route, timestamp and field names, not password/token values. Audit writes are best-effort and failures are logged on the server. History is not editable through the panel.
- **Platform settings:** Five settings tabs for branding/support, signup/security, workspace defaults, platform-wide feature controls, and sending/maintenance. These are saved configuration controls with API enforcement, not demo switches.

## Extended controls

### Manage a business from its workspace row

Open **Workspaces → Manage** beside the intended business. This panel loads only that workspace's linked accounts and provides:

- **Create account:** Reuses account setup with this business preselected. Choose Business Admin or Agent and confirm the initial password.
- **Edit account:** Update name, email and account status. Account disabling applies to all of the user's businesses, revokes existing sessions and returns unresolved chats to the unassigned queue. The final active Business Admin in any retained workspace is protected.
- **Reset password:** Enter a new password and matching confirmation. The saved platform password policy and 10-character minimum apply. The server hashes the password, serializes password changes and revokes existing sessions. Existing passwords cannot be viewed.
- **Revoke sessions:** Review and confirm sign-out across all of this account's businesses without changing its password. Your own session uses the normal Sign out control.
- **Members & roles:** Add/remove registered users, transfer ownership, choose Admin or Agent and enable/disable access in this business. The owner must remain active. Saving preserves team membership, allowed numbers, visibility, availability, capacity and claim settings. Membership removals, role changes and access disabling revoke sessions; disabled/removed members' unresolved chats return to the unassigned queue. Retired Viewer access stays disabled until explicitly reassigned and enabled.
- **Business & access, Permissions:** Open the existing configuration controls for the selected business. Usage & limits is no longer a shortcut in this management panel. **Open business workspace** provides the business's Users & Teams, WhatsApp, integrations and other business modules using explicit Super Admin access.

The management API requires an authenticated platform Super Admin. Workspace-context account, password and session mutations check that the account still belongs to the selected business. Passwords and session secrets are excluded from management responses and audit records. This addition uses existing database fields and requires no additional migration.

The responsive panel includes loading/error states, member search, empty results, keyboard focus containment and password/destructive-action confirmations. UI verification uses isolated fixtures; the live metadata endpoint is also checked without modifying accounts.

### Manage Business Admin and Agent access from Users

Expand a business under **Users**. Its **Role permissions** button opens the permission editor already scoped to that business. Choose view, create, edit, delete, send or other supported actions separately for **Business Admin** and **Agent**, then save. These settings apply to everyone with that role in this business. **Allow permitted** selects only actions allowed by the role’s security ceiling; forbidden Agent actions remain disabled. The API also rejects attempts to grant Agents billing, credentials, bulk campaigns, contact deletion or business administration. Legacy stored grants are still filtered at authorization time. Explicit Agent permission overrides now honor removal of claim access even if the member’s default claim preference is enabled; actual claiming also requires routing to allow it.

Each linked account has **Business access**, which opens Members & roles with that member’s role control focused. Choose Business Admin or Agent, enable/disable this membership and save. Account-level Edit account remains separate and can affect the account across businesses. The workspace owner retains full management access; change ownership explicitly before changing the owner’s membership. **Manage business** provides business-wide plan/module controls. Permissions cannot enable a module excluded by the effective plan, add-ons or feature blocks, and cannot expand Agent conversation visibility beyond existing team/number/assignment rules. No migration is required.

### Negotiated plan for one business

Open **Workspaces → Manage → Set custom plan**. Enter a custom name, negotiated monthly price and currency and agreement notes. The following sections appear in order: **Included WABA modules**, **Plan capacity limits**, then **Custom activity pricing**. Review the price and selected business, then choose **Apply custom plan**. The row and management summary show its custom plan; the business Billing screen displays the negotiated reference price separately from confirmed invoices. Reopen **Edit custom plan** to change the terms.

**Custom activity pricing** lists every supported charged unit with its platform default and an editable business price. These rates use INR TEST credits, independently of the monthly subscription currency. Amounts are stored as whole paise; zero is free and the maximum is INR 10,000 per unit. They are not confirmed provider tariffs or real payment collection.

Module checkboxes immediately update related capacity and activity-pricing fields. Unchecked modules remain visible with **Not included in this plan**, and their inputs are disabled. Rechecking restores editing without clearing the saved or entered values. Conversations also controls message prices; Team controls member capacity. Analytics has no separate charged unit or record capacity. Excluding a module changes its plan entitlement, rather than silently replacing its retained price or capacity with zero; independently configured add-ons and existing feature blocks continue to apply.

New businesses use global default activity pricing. Saving a custom plan stores that business's activity rates under `customPlan.activityPricesPaise`; only its future deductions use those rates. Other businesses and global pricing remain unchanged. Older custom plans without rates inherit defaults. The wallet displays the effective rates and whether their source is custom or default. Global deduction pause still applies. Price changes never refill balances or rewrite historical charges; duplicate operations retain their original price and message refunds use the original reservation amount. Charges and custom-plan changes serialize on the workspace within existing MongoDB transactions.

The override is stored in that workspace's optional `customPlan` field. Its assigned catalogue `plan` and the platform's `defaultPlan` are retained. Creating new businesses continues through the existing default-plan provisioning flow. Other businesses and catalogue prices/modules/limits are never changed by these controls. No data backfill or mandatory migration is required.

Custom plans replace the base plan's price, modules and plan capacities. Workspace capacity overrides under **Usage & limits** still take priority, including explicit zero/unlimited values. Workspace add-ons still add modules, and workspace/platform blocks still restrict them. Admin/Agent seat limits remain managed under **Business & access**. Subscription expiry and suspension remain enforced independently. Lowering a capacity does not delete existing records.

**Restore standard plan** opens a confirmation before removing the custom override. The business then uses its retained assigned catalogue plan, or unrestricted access if no standard plan was assigned, and global default activity rates. It does not adopt a newly changed platform default plan, alter other businesses, delete data or change workspace overrides.

Only platform Super Admin can read or mutate the custom-plan configuration APIs. Writes update one workspace atomically with its capacity lock and are recorded in the platform audit log. Negotiated pricing is excluded from Agent workspace metadata. Prices require up to two decimal places; invalid modules, limits and currencies are rejected on the backend. Saving a plan records commercial terms; it does not charge a card, recharge a wallet, create an invoice or claim a real payment integration.

The implementation extends `Workspace.js`, `platform.js`, `capacity.js`, `superadmin.js`, `businessReports.js` and `workspaces.js`, and adds `workspacePlan.js`, `workspacePlan.test.js` and `workspaceCustomPlan.test.js`. Frontend changes are in `WorkspaceCustomPlan.tsx`, `WorkspaceManagement.tsx`, `SuperAdmin.tsx`, `BusinessModule.tsx` and `styles.css`; default provisioning and its creation wizard are retained.

### Create an account and choose its business

Open **Users → New account**. Enter the user's name, email, initial password and matching confirmation, then choose the account's business setup:

- **Existing business:** Select a saved workspace by name and choose the user's business role: Admin or Agent. The server uses the selected workspace ID, copies its actual business name into the company profile, sets the user's default workspace and adds their membership in the same database transaction. You do not need a separate Members step. Both the selected role's seat limit and the total team-member capacity are enforced; increase the intended limit first if creation is rejected for capacity. Duplicate email, missing business or capacity failure leaves no orphan account. Suspended/expired business selection does not activate or extend that business.
- **New business:** Continue to the full business setup wizard with the user's login details prefilled in memory. Complete business details, plan, expiry, modules and limits, then create the business. This user becomes its Owner. Continuing to setup alone does not create an account, and cancelling leaves no partial account/business.
- **Platform superadmin:** No business is required. Explicitly acknowledge that this account receives platform-wide administrative access before creating it. This is not a business Admin role; keep it restricted to trusted platform administrators.

Passwords follow the saved platform policy and the 10-character administrator floor (new business owners also require uppercase, lowercase and a number). They are never saved in browser storage or placed in a URL, and are cleared after confirmed account creation. Ownership of an existing business is transferred only through **Workspaces → Members**; creating an account does not replace its existing Owner.

The editable Company field on an existing account is only a profile label and does not change business membership. Likewise, account roles and workspace membership roles are separate. Use **Workspaces → Members** to change an existing user's actual role or association. The legacy account API can still create an unassigned account when no workspace fields are supplied; the new ordinary-user creation form requires a business selection or the new-business setup flow.

### Create a configured business

Open **Workspaces → New workspace**. The setup form has four steps:

1. **Business:** Enter the workspace name, unique business identifier, optional business contact email/phone, timezone, support email and description. The identifier is suggested from the name and can be edited; leave it blank for a server-generated identifier. The business phone is a contact number, not the Smartping WhatsApp sender.
   - **Create owner login** is selected by default. Enter the owner's name, login email, initial password and matching confirmation. You do not need to create a user first. WABA uses email/password login, so the owner's email is required and must not already belong to an account.
   - **Use registered owner** selects an existing active account without changing its login. Use this when the business owner already has a WABA account.
   - Initial passwords need at least 10 characters (or the longer platform minimum), uppercase, lowercase and a number, and must fit within 72 UTF-8 bytes. Passwords are hashed on the server and are not returned, displayed in Review, or emailed. Share the initial login securely with the owner.
2. **Access & plan:** Use the platform's default plan or choose another active plan/no plan restriction. Select additional WABA modules beyond the plan, block individual workspace modules, set active/suspended status and WhatsApp sending permission. Configure default expiry, trial days, exact local expiry time or no expiry. The review shows the exact expiry in UTC; global restrictions and workspace blocks still take priority over add-ons. Selecting a plan or add-on does not collect a payment.
3. **Capacity:** Configure separate business admin and agent seat limits. Blank means unlimited for that role; zero prevents new members in that role. Saved memberships count even if an account is suspended. The owner is excluded from role limits but counts toward total team-member capacity. For record/member capacities, leave blank to inherit plan limits, enter whole numbers, or choose Unlimited. Zero blocks new ordinary-user records. Add private administrator notes if needed.
4. **Review:** Check the non-secret configuration, then click **Create workspace**. A new owner login, workspace, settings and owner membership are saved in one database transaction. Duplicate email/identifier and validation failures do not leave a partial business or orphan owner account. An existing owner's default workspace is preserved.

These choices affect the new workspace only. They do not connect Smartping, collect a payment, change existing workspaces, or replace the owner's existing default workspace. Wallet controls, provider credentials, additional members and role permissions remain in their dedicated sections.

After creation, use **Edit access** to update business contacts, plan, add-on modules, blocked modules and role seat limits. Role-seat JSON uses `admin` and `agent`, with whole numbers from 0 to 100000 or `null` for unlimited. Existing memberships are retained when a limit is lowered; ordinary invitations enforce both role seats and total-member capacity. Superadmins retain their explicit quota override.

This onboarding follows the relevant JustConnect-CRM business setup fields without copying its telephony/PBX provisioning, supervisor role, generated login IDs or plaintext-password welcome emails. Only implemented WABA modules are available as add-ons. JustConnect-CRM remains unchanged.

### Other extended controls

- **Permissions:** Select a workspace and grant/revoke individual read, create, update, delete, send, team-management and workspace-management capabilities for admins and agents. Save to apply. “Restore defaults” removes custom role rules. Empty custom permissions deny all mapped actions for that role. Owner and superadmin access cannot be restricted here. Permissions do not grant access to plan-disabled features or fabricate provider states. The API checks the latest rules on each request; refresh a tenant dashboard to update its visible sections.
- **Usage & limits:** See actual stored record/member counts. Choose plan inheritance, an explicit capacity or an unlimited workspace override. Zero blocks new ordinary-user records. Existing records are retained. Superadmins can manage data above tenant quotas. Plan-wide limits can be edited in the Plans form: a JSON object such as `{"contacts":1000,"members":10,"templates":null}`. An omitted key means unlimited unless the workspace inherits a plan value; `null` explicitly means unlimited. These are record capacities, not message credits or automatic subscription billing.
- **Security:** View account status, last login and session revocation version. Revoke one account's sessions, or sign out other accounts using explicit confirmation. Other superadmins are excluded from global revocation unless selected, and the current account is always excluded. Revoked browsers return to login on their next API request. The panel does not claim to list active devices because JWT sessions are stateless.
- **Monitoring:** Inspect actual message statuses and stored provider errors across all workspaces or a selected workspace, filtered by message status. No uncertain message is automatically resent. Message exports include saved provider identifiers and errors, not credentials.
- **Announcements:** Create, edit, publish and remove notices for all or selected workspaces, with optional start/end times. Active notices appear in the tenant dashboard and notification menu. Tenant dashboards refresh notices every minute. A published notice outside its date window does not appear.
- **Bulk workspace controls:** Select up to 50 workspaces from the current results page, choose suspend/reactivate access or pause/resume sending, and confirm the exact operation. Existing records are not deleted. Selecting “Resume” does not bypass a separate maintenance switch or expired subscription.
- **CSV exports:** Export users, workspaces or every record in the selected workspace/resource in cursor-based batches. Exports omit passwords, session secrets and private admin notes; spreadsheet formula-leading cells are neutralized. Exports are audited. These are data exports, not full encrypted database backups or a restore mechanism.
- **Clone record:** Clone an editable resource into the same workspace through its editor. Review the copy before saving; name-bearing records receive an `_copy` suffix, and duplicate names/numbers may require adjustment. Provider messages and generated reports cannot be cloned or edited into fabricated statuses.

No existing workspace's permission rules, capacities, notices or sessions are changed merely by installing these screens. Business access supports Admin and Agent only; owners retain Admin management access. Existing Viewer memberships are kept as records but require explicit reassignment through Members before they can access a workspace. Stored Viewer permission rules cannot restore access.

## Platform settings

Open **Platform settings** in the Superadmin sidebar. Choose a category, edit the controls, then click **Save platform settings**. The save bar shows the number of changed settings. **Discard edits** restores the last saved values. Switching category tabs keeps unsaved edits; leaving the page discards them. Category navigation supports refresh and browser back/forward.

- **Branding & support:** Platform name, sign-in heading/description, support email/phone/website, footer text, and optional Terms of Service/Privacy Policy links. The name appears in the sign-in page and both sidebars. A preview shows your edited branding. Website/legal links must use HTTPS without embedded credentials. These contacts are public support details, not Smartping credentials.
- **Signup & security:** Allow/block public signup; pause ordinary-account sign-in and workspace API access; restrict public signup to exact email domains; configure minimum password length, optional uppercase/number requirements, and newly issued session lifetime. Superadmins retain sign-in and inspection access when member access is paused. An empty domain list allows any valid email domain; existing logins and superadmin-created accounts are not domain-restricted. Password length is 8-64 characters, with a 72 UTF-8-byte maximum; admin-created/reset passwords require at least 10 characters. Rules apply to new/reset passwords only. Existing passwords are not changed. Session lifetime accepts 1-720 hours, or empty to inherit `JWT_EXPIRES_IN` (server fallback: seven days). Existing tokens keep their issued expiry; use **Security** to revoke them.
- **Workspace defaults:** Default timezone, active plan, initial subscription/trial days, maximum workspaces owned by one account, and an additional-workspace creation switch. Defaults affect new workspaces only, including superadmin-created workspaces. Zero trial days means no automatic expiry. An empty owner limit means unlimited; zero blocks ordinary creation and public signup. Superadmins can provision above this ownership limit. If a configured default plan is later archived, new creation fails safely until you choose an active plan or remove the default. Existing assignments are retained.
- **Feature controls:** Enable/disable each implemented module platform-wide. Ordinary workspaces receive their plan features plus explicitly assigned WABA add-ons, minus workspace and global restrictions; role permissions cannot bypass a disabled module. Superadmins can inspect restricted records. Actual sends still require Conversations and Templates, and broadcast sends also require Campaigns.
- **Sending & maintenance:** Global template sending switch, independent broadcast dispatch switch, maximum recipients per broadcast request (1-100, within the current integration limit), maintenance mode, and the public maintenance notice. Disabling broadcasts leaves individual template messages available when other sending policies permit them. Each new campaign message rechecks sending policy, so a paused broadcast stops before the next unaccepted send. Accepted messages are not recalled, and delivery callbacks remain active. This recipient cap is not a daily credit limit or provider rate limit.

Related links open the existing Security, Plans, Usage & limits, Permissions, Workspaces, Announcements and Integrations screens. Saving platform configuration does not contact a provider, charge a customer, rewrite existing subscriptions, or reset passwords. Existing databases receive the new defaults when read; no migration or live configuration change is required to install the feature.

## Enforcement and limits

### Test wallets and activity charges

Every business receives a saved test wallet. On first initialization it gets one random balance between **INR 5,000 and INR 10,000**, inclusive, using the configured opening range. Existing businesses are initialized when the updated server starts; newly created businesses are initialized on first wallet access or billable activity. Reading a wallet, restarting the server, and clicking **Initialize missing wallets** never refill an existing balance. To initialize manually from `WABA/server`, run `npm run seed-test-wallets`. This creates only missing test wallets and their opening-credit entries.

The default dummy prices are:

| Activity | Charged unit | Test INR price |
| --- | --- | ---: |
| Contacts | New contact | 1.00 |
| Conversations | New conversation | 2.00 |
| Messages | Outgoing template request | 0.75 |
| Calls | New call log | 5.00 |
| Campaigns | New campaign | 10.00 |
| Templates | New template | 3.00 |
| Automations | New bot record | 8.00 |
| Dashboards | New dashboard | 15.00 |
| Reports | Generated report | 5.00 |
| Segments | New segment | 2.00 |
| Ads | New stored ad | 20.00 |

These are fictional testing prices, not Meta/Smartping tariffs. Existing records are not back-billed. Viewing pages, reading data, updating/deleting a record, report downloads, signup/workspace creation, and incoming provider callbacks are free. A campaign's creation, any new conversations it creates, and its individual outgoing messages are separate activities. Calls, ads and bots are charged when their records are created; no unimplemented provider calling, ad publishing or bot execution is simulated. Direct superadmin Workspace data editor operations remain administrative and free; business-workspace APIs, including superadmin workspace access, follow normal test prices.

1. In **Superadmin -> Wallet & pricing**, change each price in INR and click **Save test pricing**. Amounts are stored as integer paise to avoid rounding errors. Zero means free. Prices apply to future activity and past entries keep their original price.
2. Turn automatic deductions off to pause charging without changing balances/history. Opening credit settings affect only missing/new wallets, not existing businesses.
3. Choose a business to see its balance and history. Add/remove test credits with a positive amount and a reason; the ledger records your administrator identity. Retries with the same request key are applied once. Removing more credits than available is rejected.
4. Businesses see their balance in the sidebar and can open **Wallet** to view prices and transactions. Balance refreshes after activity and every 30 seconds. The `wallet.read` permission controls viewing; only superadmins can modify prices or balances.

Record creation and its test deduction commit in the same MongoDB transaction. Failed validation, capacity limits, and insufficient balance cannot leave a charge without a saved activity. New paid activities return HTTP 402 when funds are insufficient. Balances cannot go negative. Each charge stores a workspace-scoped unique operation key, actor, record identifier, price snapshot and resulting balance. Ledger entries cannot be edited/deleted through these APIs; corrections are new entries.

Outgoing messages reserve their price **before** contacting the provider. A duplicate message request key returns the saved message and never charges or sends again. Provider acceptance or an authenticated delivery callback completes the reservation without a second deduction. An explicit pre-acceptance rejection refunds the original reservation exactly once, provided no provider acceptance/callback is already recorded. Delivery failures after acceptance remain charged. Timeouts and other uncertain sends stay reserved; verify provider reports before manually correcting credits through the superadmin wallet. Nothing automatically retries those sends.

This feature is always labeled **test** and uses INR only. It does not connect a payment gateway, withdraw money, update invoice payments, or bill actual provider charges. Use a separate reviewed payment integration before accepting real funds.

For a read-only database reconciliation, run `npm run check-test-wallets` in `WABA/server`. It checks wallet/ledger totals, exactly one opening entry per wallet, non-negative integer balances, and whether all current businesses have wallets. It prints counts only, not user details or credentials.

Normal users are blocked by workspace suspension, subscription expiry, maintenance and disabled features at the API, not just in the menu. Superadmins can inspect restricted workspaces, but sending is still blocked by the global/workspace sending switches, expiry and suspension. Already accepted sends and their delivery callbacks cannot be recalled by disabling sending.

Public registration creates the first workspace for the new owner. The additional workspace creation switch applies to subsequent workspace creation and automatic legacy-owner provisioning. Removed agents are not silently upgraded to owners when signing in.

The panel controls WABA's implemented services and database records. It cannot override Meta approvals or provider delivery results. Live inbound WhatsApp handling, template approval APIs, Meta Ads synchronization and scheduled bot execution still require their provider APIs/execution services. Ads fields are stored records, not a live Meta sync. Smartping credentials are not required to manage WABA accounts and workspaces, but they are required for actual sending.

Account role updates, workspace provisioning and ordinary capacity-checked record creation use MongoDB transactions to serialize access/capacity changes. Public registration creates its user and first workspace in the same transaction, so an unavailable plan or provisioning failure cannot leave an orphan account. Ownership quotas serialize on the owner account before counting existing workspaces. Team invitation capacity is checked in an atomic member update. Use the project's MongoDB Atlas setup or another replica-set MongoDB deployment; standalone MongoDB does not support those transactions.

## Verify

Fresh Business Admin and Agent logins open their dashboard (`Overview`) using the verified business membership role. Explicit page links and refreshes remain available after login. Workspace loading or access errors do not overwrite saved navigation with a Settings fallback. An expired or disabled business still rejects data access until its configuration is explicitly restored.

The **Business & access** editor uses an exact local expiry date and time, converted to UTC before saving. Editing unrelated fields preserves the original expiry instant, including milliseconds. Clearing the expiry selects no expiry for that business only. Creating a new business still uses the platform's configured plan and expiry defaults.

### Individual Agent permissions

In **Users**, expand the business, choose **Business access**, then choose **Custom permissions** beside a saved Agent. Uncheck **Use business role permissions**, select the standard Agent actions and save. The account remains an Agent. Each override applies only to that member in that business; other members retain their role defaults. Saving permissions does not enable disabled business access. Newly added members or changed roles must be saved before configuring individual permissions.

The available actions cover the personal dashboard, permitted contacts, inbox replies and updates, call logs, approved templates, shared content viewing and claiming unassigned chats. Claiming still requires routing eligibility. Plan restrictions, allowed numbers, assigned conversation scope and editable contact fields remain enforced. Billing, integrations, administration, bulk campaigns and export/delete actions remain outside the Agent security ceiling.

`GET/PUT /api/superadmin/workspaces/:workspaceId/members/:userId/permissions` are platform Super Admin only. A PUT requires `expectedVersion` and `permissions`: an array replaces inherited actions, an empty array removes all feature actions, and `null` restores business role inheritance. Transaction serialization and per-member versions reject stale saves with HTTP 409. Existing requests read the current membership on every API request. Successful writes are recorded in the platform audit log without credentials. Generic membership edits preserve overrides; role changes clear them to prevent later reuse of old privileges.

No data migration is required. Existing memberships have no override and retain their current role rules. The new optional `customPermissions` field defaults to `null`, and `permissionVersion` defaults to zero. Tests use isolated fixtures; installing or verifying this feature does not grant live users new permissions.

From `WABA/server`: `npm test`.

From `WABA/client`: `npx tsc --noEmit`.

From `WABA`: `npm run build`.

The automated tests use mock model methods, not your live database or Smartping account.
