import { createContext, useContext } from 'react';
import { can, type WorkspaceAccess } from './workspaceAccess';
export const WorkspaceAccessContext = createContext<WorkspaceAccess>({ role: 'agent', permissions: [], features: [], superadmin: false });
export function useWorkspaceAccess() { const access = useContext(WorkspaceAccessContext); return { ...access, can: (capability: string) => can(access, capability) }; }
export function Permission({ capability, children }: { capability: string; children: React.ReactNode }) { const access = useWorkspaceAccess(); return access.can(capability) ? <>{children}</> : null; }
