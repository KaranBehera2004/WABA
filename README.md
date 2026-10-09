# WABA Dashboard

Professional WhatsApp Business Account dashboard built with MongoDB Atlas, Express, React, and Node.js.

## Setup

1. Install dependencies: `npm run install:all`
2. Copy `server/.env.example` to `server/.env` and add your MongoDB Atlas URI.
3. Copy `client/.env.example` to `client/.env` if the API is hosted separately.
4. Create the first user: `npm run create-admin --prefix server -- --email you@example.com --password YourPassword --name "Your Name"`
5. Start both apps: `npm run dev`

The React app runs at `http://localhost:5173` and the API at `http://localhost:5000`.

## Superadmin panel

Platform administrators can manage WABA workspaces, users, memberships, plans, invoices, stored records, integration readiness, audit history and platform access settings. Follow [the superadmin setup guide](server/SUPERADMIN.md) to grant a chosen registered account access. Ordinary workspace admins do not receive platform access automatically.

The panel also includes role-level permission matrices, workspace/plan record capacities, session revocation, cross-workspace message monitoring, targeted announcements, CSV exports and confirmed bulk workspace controls. These changes are opt-in; existing workspaces keep their default access until an administrator saves a restriction.

Platform settings include branding and support/legal links, public signup/domain/password policies, new-session lifetime, workspace plan/trial/timezone defaults, owner workspace quotas, global module access, broadcast controls and maintenance. Controls are grouped into five tabs and enforced by the server. Existing passwords and workspace subscriptions are not rewritten. See [Platform settings in the guide](server/SUPERADMIN.md#platform-settings) for each control's scope.

**Test wallets:** Businesses get one-time random INR 5,000-10,000 dummy credits. Superadmin **Wallet & pricing** controls all eleven activity prices, deductions, opening ranges and credit/debit adjustments. Business Wallet screens show saved balances and transaction history. New record/report creation is charged atomically; outgoing template requests reserve credits before sending, and duplicate requests never charge twice. These are test credits only, not real payments. Existing records are not back-billed. Restart the updated server to initialize current businesses, or run `npm run seed-test-wallets --prefix server`. See [the test wallet guide](server/SUPERADMIN.md#test-wallets-and-activity-charges).

Workspace records, dashboards, reports, filters, profile data, teams, templates, segments, campaigns, calls, and conversations are stored in MongoDB. Smartping template dispatch and delivery callbacks are supported as described in [the integration setup guide](server/SMARTPING.md). Inbound message handling, Meta template approval, Meta Ads synchronization, and scheduled automation execution need separate provider API documentation and are not simulated.


## Role-specific workspace experience

The workspace header shows the current workspace name, independently of platform branding. The dashboard uses the role returned by `/api/workspaces/current` (`membershipRole`), rather than the account's global role. Older responses can resolve the role from the matching member identity. If neither source verifies membership, the interface shows an access error instead of silently choosing a role. Restart the API to provide the authoritative role when team-directory access is disabled.

| Workspace role | Dashboard | Default tools |
| --- | --- | --- |
| Admin (including the business owner) | Business management layout: command shortcuts, campaign monitor, team role distribution, channel health and workspace activity | All enabled business modules, team invitations with Admin and Agent choices, broadcasts, reports, channel settings and wallet |
| Agent | Personal workboard with awaiting-reply and open columns, conversation resolution, shared queue and callback follow-up | Inbox and approved-provider template sending, contact creation/updates, customer segments, assigned call logs, saved template viewing and test wallet |

Business memberships support Admin and Agent only. Agent defaults exclude campaign administration, automations, ad management, report generation, team management and channel configuration. Saved permission rules can customize these two roles; disabled workspace modules still override grants. Existing stored Viewer memberships and settings are retained for administrative reassignment, but they no longer authorize workspace access, even when old custom grants exist. No accounts are automatically promoted or reassigned. Business ownership remains an internal record and displays as Admin in the business interface.

Permissions control navigation, dashboard shortcuts, creation forms, editing, sending, report generation, channel configuration and team invitations. The existing API middleware remains the security boundary. Dashboard workload queries are scoped to the current workspace and agent; disabled modules and absent read permissions do not return workload details.

The interface includes grouped navigation, page search, responsive cards and tables, light/dark themes, mobile navigation, inbox back navigation and a collapsible desktop sidebar. Platform announcements include search, publishing-status filters, summary cards and badges that distinguish live, scheduled, draft and expired notices.

Restart both the WABA API and client after updating. No database migration or new environment variables are required. Existing provider capabilities and limitations described above remain in effect.

Verification commands:

- Client type check: `cd client && node node_modules/typescript/bin/tsc --noEmit`
- Client build: `npm run build --prefix client`
- Client tests: `cd client && node --test tests/*.test.mjs`
- Server tests: `npm test --prefix server`

Browser QA previews are saved in `qa/`. They use intercepted sample API responses, not production records or live message sends. The application itself continues to load its data from the existing API.
