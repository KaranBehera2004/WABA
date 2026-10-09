# WABA business role access guide

This change extends WABA's existing React/TypeScript client and Express/Mongoose backend. JustConnect-CRM is a read-only reference and was not modified.

## Create a workspace in Super Admin

1. Sign in as platform Super Admin. Open **Workspaces → New workspace**.
2. In **Business**, enter business and owner details, or choose an existing owner account.
3. Open **Access & plan**. Under **Roles this business may create**, select Business Admin, Agent and/or Supervisor. Existing businesses default to Business Admin and Agent; Supervisor creation requires an explicit selection.
4. Under **Feature permissions by role**, check each action the role should have. Keep **Dashboard → View** enabled for each role that needs its dashboard. View and write actions are separate: select the relevant View action as well as Create/Edit/Send when needed.
5. Leave **Assigned plan** on **Use platform default** to retain the normal creation plan. Modules must be included in the plan or allowed add-ons, and must not be blocked at workspace/platform level.
6. Set the expiry and role seat limits, then review and create. Workspace access must remain active, and its subscription must not have expired.

## Manage permissions for an existing business

1. Open **Super Admin → Workspaces → Manage** for that business.
2. Open **Roles & creation access**.
3. Select roles the business is allowed to create and actions each role can use. You can explicitly enable advanced features for Agent or Supervisor without promoting them to Business Admin. Platform Super Admin privileges are never granted through this screen.
4. Click **Save role access**. This saves both the Super Admin permission ceiling and the business's shared role permissions. Changes apply to this business only.
5. Open **Members & roles** to add a registered account, change its business role, or enable/disable its business access. Save members.
6. An Agent with individual permissions follows that override. In that Agent's permissions panel, select **Use business role permissions** to inherit the shared policy, or select the desired individual actions within the Super Admin ceiling.
7. In **Business & access**, manage the exact subscription expiry and all three role seat limits. Custom negotiated plans remain under **Set custom plan / Edit custom plan**.

## Create and manage users as Business Admin

1. Sign in to that business and open **Users & Teams**. This requires Users & Teams → View; management requires Users & Teams → Manage.
2. Choose **Create user** to immediately create a platform account plus this business's membership. Choose **Invite user** for an invitation, or **Add existing account** for an already registered user.
3. Choose an allowed Business Admin, Agent or Supervisor role. Roles not enabled by Super Admin cannot be created through the business API or UI.
4. Share the private password setup/invitation link securely with the intended user. Links expire after 48 hours and are single use; automatic email delivery is not configured. Never post these links publicly.
5. Create teams, then edit the member's teams, allowed WhatsApp numbers, conversation visibility, availability and chat capacity. Assign Supervisors to the teams they should oversee. No team/number mappings are granted automatically.
6. Open **Role permissions** to narrow or enable actions within the ceiling selected by Super Admin. Locked actions say **Enable in Super Admin**; a Business Admin cannot increase their own ceiling.
7. Business-created users appear in **Super Admin → Users**, grouped under their business, and in **Workspaces → Manage → Accounts & security**. The Users directory refreshes on focus and every 30 seconds; use platform refresh to reload immediately.

## Dashboard and access behavior

- Business Admin: business overview, with permitted conversation metrics, team workload, campaign delivery, connection and billing panels.
- Agent: personal work desk and assigned conversation access. Explicit additional feature grants appear in navigation. Grants do not bypass business isolation or conversation scope.
- Supervisor: team overview, with assigned team conversations, permitted numbers and scoped workload/response metrics.
- Keep Dashboard → View enabled; keep Inbox → View enabled for conversation metrics and inbox navigation. Reply and conversation changes require the relevant Send/Edit actions.
- A role grant alone cannot restore a disabled account, disabled membership, expired subscription, excluded plan module or an individual permission override. Each is checked separately by the backend.
- Disabling a role's creation permission preserves existing memberships, but blocks new accounts, invitations and role changes into that role.
- The owner remains the protected Business Admin for the business. The last active Business Admin cannot be removed or demoted.
- Viewer is not a creation role. Legacy Viewer memberships stay denied and are retired/disabled when the workspace is next validated and saved, pending explicit reassignment.

## Data and deployment

No destructive migration or business renewal is performed. Role policy, version and Supervisor seat fields use safe defaults on existing workspace documents. Deploy/restart the WABA backend and load the new frontend build together. Existing sessions reload their workspace permissions on focus; backend authorization checks fresh permissions on each request.

The new APIs are root-only GET/PUT /api/superadmin/workspaces/:id/role-policy; business GET/PUT /api/business/role-access; and business POST /api/business/users. Writes use transactions, fresh permission checks, version conflicts or atomic membership/seat predicates as appropriate. Sensitive writes retain audit events.

Queued campaign and automation jobs recheck the actor’s active membership, current permissions, plan modules and expiry. Agent/Supervisor campaign sends require an explicitly allowed sending number; journey enrollment remains within permitted conversation scope.

Provider configuration and real billing dependencies remain unchanged. No real customer campaign was sent during development or verification.

Impactvibes' saved expiry (9 October 2026, 5:30 AM IST) has not been changed. A new exact expiry must be set through Business & access before that expired business can open its dashboard.

## Changed areas and verification

Key frontend files: client/src/components/RoleAccessEditor.tsx, CreateWorkspaceModal.tsx, WorkspaceManagement.tsx, BusinessModule.tsx, BusinessOperations.tsx, AgentPermissionsDialog.tsx; client/src/pages/Dashboard.tsx, SuperAdmin.tsx and pages/dashboards/SupervisorDashboard.tsx; client/src/lib/workspaceAccess.ts and business.css.

Key backend files: server/src/models/Workspace.js, User.js and Business.js; server/src/services/accessControl.js, businessAccess.js, businessPolicy.js, assignment.js and businessJobs.js; middleware/workspace.js; routes/superadminOperations.js, business.js, workspaces.js, businessReports.js, businessCampaigns.js and businessAutomations.js. Related account, dashboard and data routes were extended to support the approved role grants.

Checks passed: 291 backend tests; 58 frontend tests; TypeScript noEmit check; Vite production build. Browser checks used intercepted API fixtures at 1440px, 820px and 390px and verified role dashboards, workspace creation controls, root permission saving, business user role choices and read-only template controls. HTTP permission and concurrency regressions use mocked database adapters; no live provider send or live MongoDB race test was performed. The build retains a non-blocking large-bundle warning.

All 651 pre-recorded JustConnect-CRM file hashes matched after implementation.
