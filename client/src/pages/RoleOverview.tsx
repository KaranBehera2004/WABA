import type { User, Workspace } from '../lib/api';
import { useWorkspaceAccess } from '../lib/WorkspaceAccessContext';
import BusinessAdminDashboard from './dashboards/BusinessDashboard';
import AgentDashboard from './dashboards/AgentDashboard';
import SupervisorDashboard from './dashboards/SupervisorDashboard';

export type Conversation = { _id: string; contact?: { name?: string; phone?: string }; lastMessage?: string; lastMessageAt?: string; status: string };
export type OverviewData = {
  metrics: { contacts: number; conversations: number; sent: number; delivered: number; read: number };
  chart: { day: string; sent: number; delivered: number; read: number }[];
  recentConversations: Conversation[];
  templates: { _id: string; name: string; category: string; status: string }[];
  workload?: { open: number; awaitingReply: number; closed: number; unassigned: number; callbacks: number; queue: Conversation[]; unassignedQueue?: Conversation[] } | null;
};
export const emptyOverview: OverviewData = { metrics: { contacts: 0, conversations: 0, sent: 0, delivered: 0, read: 0 }, chart: [], recentConversations: [], templates: [] };
export type DashboardProps = { data: OverviewData; loading: boolean; error: string; user: User; workspace: Workspace | null; period: string; setPeriod: (value: string) => void; navigate: (page: string) => void; openModal: (type: string) => void; onNotice: (message: string) => void };
export default function RoleOverview(props: DashboardProps) {
  const access = useWorkspaceAccess();
  if (!access.superadmin && access.role === 'agent') return <AgentDashboard {...props}/>;
  if (!access.superadmin && access.role === 'supervisor') return <SupervisorDashboard {...props}/>;
  return <BusinessAdminDashboard {...props}/>;
}
