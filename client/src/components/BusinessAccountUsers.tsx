import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

type Account = Record<string, any> & { _id: string };
export type BusinessUserGroup = { id: string; name: string; business?: Account; accounts: { user: Account; role?: string; disabled?: boolean }[] };
const recordId = (value: any) => String(value?._id || value || '');
const roleLabel = (role?: string) => role === 'owner' || role === 'admin' ? 'Business Admin' : role === 'supervisor' ? 'Supervisor' : role === 'agent' ? 'Agent' : role === 'viewer' ? 'Access disabled — reassignment required' : role || 'Platform account';

export function groupBusinessUsers(businesses: Account[], users: Account[], query: string): BusinessUserGroup[] {
  const byId = new Map(users.map(user => [user._id, user]));
  const grouped = new Set<string>();
  const groups: BusinessUserGroup[] = businesses.map(business => {
    const members = new Map<string, BusinessUserGroup['accounts'][number]>();
    for (const member of business.members || []) {
      const user = byId.get(recordId(member.user));
      if (!user) continue;
      members.set(user._id, { user, role: member.role, disabled: Boolean(member.disabled) || member.role === 'viewer' });
      grouped.add(user._id);
    }
    return { id: business._id, name: business.name, business, accounts: [...members.values()] };
  });
  const platform = users.filter(user => user.role === 'superadmin' && !grouped.has(user._id));
  const unassigned = users.filter(user => user.role !== 'superadmin' && !grouped.has(user._id));
  if (platform.length) groups.push({ id: 'platform', name: 'Platform accounts', accounts: platform.map(user => ({ user, role: 'Super Admin' })) });
  if (unassigned.length) groups.push({ id: 'unassigned', name: 'Accounts without a business', accounts: unassigned.map(user => ({ user })) });
  const search = query.trim().toLowerCase();
  return groups.flatMap(group => {
    if (!search || group.name.toLowerCase().includes(search)) return [group];
    const accounts = group.accounts.filter(({ user }) => `${user.name} ${user.email}`.toLowerCase().includes(search));
    return accounts.length ? [{ ...group, accounts }] : [];
  });
}

type Props = { groups: BusinessUserGroup[]; currentUser: string; selected: string[]; onSelect: (id: string, selected: boolean) => void; onEdit: (user: Account) => void; onReset: (user: Account) => void; onDelete: (user: Account) => void; onPermissions: (business: Account) => void; onBusinessAccess: (business: Account, user: Account) => void; onManage: (business: Account) => void };

export default function BusinessAccountUsers({ groups, currentUser, selected, onSelect, onEdit, onReset, onDelete, onPermissions, onBusinessAccess, onManage }: Props) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [memberPages, setMemberPages] = useState<Record<string, number>>({});
  return <div className="admin-business-users">
    {!groups.length && <div className="admin-empty">No businesses or accounts match your search.</div>}
    {groups.map(group => {
      const open = expanded.includes(group.id);
      const page = Math.min(memberPages[group.id] || 1, Math.max(1, Math.ceil(group.accounts.length / 50)));
      const accounts = group.accounts.slice((page - 1) * 50, page * 50);
      return <section className="admin-business-user-group" key={group.id}>
        <button className="admin-business-user-toggle" aria-expanded={open} aria-controls={`business-users-${group.id}`} onClick={() => setExpanded(current => open ? current.filter(id => id !== group.id) : [...current, group.id])}>
          {open ? <ChevronDown size={19} aria-hidden="true"/> : <ChevronRight size={19} aria-hidden="true"/>}
          <span><b>{group.name}</b><small>{group.accounts.length} {group.accounts.length === 1 ? 'account' : 'accounts'}</small></span>
          {group.business && <span className={`admin-badge ${group.business.isActive !== false ? 'good' : 'bad'}`}>{group.business.isActive !== false ? 'Active business' : 'Suspended business'}</span>}
        </button>
        {open && <div id={`business-users-${group.id}`} className="admin-business-user-content">
          {group.business && <div className="admin-business-access-tools"><div><b>Roles & feature access</b><p>Role permissions apply to this business’s Business Admins or Agents. Use Business access to change a member’s role or enable/disable their access. The business plan determines which modules are available.</p></div><div className="admin-row-actions"><button className="outline-reference" onClick={() => onPermissions(group.business!)}>Role permissions</button><button className="outline-reference" onClick={() => onManage(group.business!)}>Manage business</button></div></div>}
          <div className="admin-table-wrap"><table><thead><tr>{['Account', 'Business role', 'Access', 'Last login', 'Actions'].map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>
            {!accounts.length ? <tr><td colSpan={5} className="admin-empty">No accounts are linked to this business.</td></tr> : accounts.map(({ user, role, disabled }) => <tr key={user._id}>
              <td><label className="admin-delete-row"><input type="checkbox" aria-label={`Select account ${user.name} in ${group.name}`} disabled={user._id === currentUser} checked={selected.includes(user._id)} onChange={event => onSelect(user._id, event.target.checked)}/><span><b>{user.name}</b><small>{user.email}</small></span></label></td>
              <td><span className="admin-badge">{roleLabel(role)}</span></td><td>{!user.isActive ? 'Account suspended' : disabled ? 'Business access disabled' : 'Active'}</td><td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</td>
              <td><div className="admin-row-actions">{group.business && <button onClick={() => onBusinessAccess(group.business!, user)}>Business access</button>}<button onClick={() => onEdit(user)}>Edit account</button><button onClick={() => onReset(user)}>Reset password</button><button className="danger" disabled={user._id === currentUser} title={user._id === currentUser ? 'Your signed-in account is protected' : 'Preview account deletion'} onClick={() => onDelete(user)}>Delete</button></div></td>
            </tr>)}
          </tbody></table></div>
          {group.accounts.length > 50 && <div className="admin-pagination"><span>{group.accounts.length} accounts · page {page}</span><button disabled={page === 1} onClick={() => setMemberPages(current => ({ ...current, [group.id]: page - 1 }))}>Previous accounts</button><button disabled={page * 50 >= group.accounts.length} onClick={() => setMemberPages(current => ({ ...current, [group.id]: page + 1 }))}>Next accounts</button></div>}
        </div>}
      </section>;
    })}
  </div>;
}
