import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RiArrowLeftLine, RiRefreshLine, RiUserAddLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { Checkbox } from '@/components/base/checkbox/checkbox';
import { Input } from '@/components/base/input/input';
import { api } from '@/src/api';
import type { TeamMember, TeamRole } from '@/src/api';

const operationalRoles: TeamRole[] = ['author', 'reviewer', 'deployer', 'runner'];
const roleLabels: Record<TeamRole, string> = {
  admin: 'Admin',
  author: 'Author',
  reviewer: 'Reviewer',
  deployer: 'Deployer',
  runner: 'Runner',
};

type MemberDraft = { roles: TeamRole[]; enabled: boolean };
type LoadState = 'loading' | 'ready' | 'error';

function messageFor(error: unknown, fallback: string) {
  const { code, status } = (error as { code?: string; status?: number } | null) ?? {};
  if (code === 'team.member_exists') return 'This SSO identity already has a membership. Search for it below.';
  if (code === 'team.member_conflict') {
    return 'This membership changed elsewhere. Reload the list before saving again.';
  }
  if (code === 'team.admin_immutable') return 'An administrator membership can only be changed in your SSO setup.';
  if (status === 401) return 'Open this workspace through your organization’s sign-in page.';
  if (status === 404 && code !== 'team.member_not_found') return 'Team settings are unavailable in this workspace.';
  if (code === 'auth.denied' || status === 403) {
    return 'Your administrator access changed. Reload the page or contact your workspace administrator.';
  }
  return fallback;
}

function sortRoles(roles: TeamRole[]) {
  return [...roles].sort();
}

function sameDraft(member: TeamMember, draft: MemberDraft) {
  const current = sortRoles(member.roles);
  const next = sortRoles(draft.roles);
  return member.enabled === draft.enabled && current.length === next.length && current.every((role, index) => role === next[index]);
}

export function TeamSettingsView({ onBack }: { onBack: () => void }) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [drafts, setDrafts] = useState(() => new Map<string, MemberDraft>());
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState('');
  const [newRoles, setNewRoles] = useState<TeamRole[]>(['author']);
  const [newEnabled, setNewEnabled] = useState(true);
  const [addError, setAddError] = useState('');
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState(() => new Map<string, string>());
  const [notice, setNotice] = useState('');
  const requestSequence = useRef(0);
  const mutationPending = useRef(false);

  const load = useCallback(async () => {
    if (mutationPending.current) return;
    const requestId = ++requestSequence.current;
    setLoadState('loading');
    setLoadError('');
    try {
      const result = await api.getTeamMembers();
      if (requestSequence.current !== requestId) return;
      setMembers(result.members);
      setDrafts(new Map());
      setSaveErrors(new Map());
      setLoadState('ready');
    } catch (error) {
      if (requestSequence.current !== requestId) return;
      setLoadError(messageFor(error, 'Team memberships could not be loaded. Try again.'));
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { requestSequence.current += 1; };
  }, [load]);

  const visibleMembers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return members.filter((member) => !needle || member.subject.toLocaleLowerCase().includes(needle));
  }, [members, query]);

  const updateDraft = (member: TeamMember, patch: Partial<MemberDraft>) => {
    setDrafts((current) => new Map(current).set(member.subject, {
        roles: current.get(member.subject)?.roles ?? [...member.roles],
        enabled: current.get(member.subject)?.enabled ?? member.enabled,
        ...patch,
    }));
    setSaveErrors((current) => new Map(current).set(member.subject, ''));
  };

  const toggleRole = (member: TeamMember, role: TeamRole, selected: boolean) => {
    const draft = drafts.get(member.subject) ?? member;
    const roles = selected ? [...draft.roles, role] : draft.roles.filter((item) => item !== role);
    updateDraft(member, { roles: sortRoles(roles) });
  };

  const addMember = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanSubject = subject.trim();
    if (mutationPending.current || loadState !== 'ready' || !cleanSubject || newRoles.length === 0) return;
    mutationPending.current = true;
    setAdding(true);
    setAddError('');
    setNotice('');
    try {
      const result = await api.addTeamMember({ subject: cleanSubject, roles: sortRoles(newRoles), enabled: newEnabled });
      setMembers((current) => [...current.filter((member) => member.subject !== result.member.subject), result.member]
        .sort((a, b) => a.subject.localeCompare(b.subject)));
      setSubject('');
      setNewRoles(['author']);
      setNewEnabled(true);
      setNotice('Identity added.');
    } catch (error) {
      setAddError(messageFor(error, 'Could not add that SSO identity. Check the subject and try again.'));
    } finally {
      mutationPending.current = false;
      setAdding(false);
    }
  };

  const saveMember = async (member: TeamMember) => {
    const draft = drafts.get(member.subject);
    if (mutationPending.current || !draft || sameDraft(member, draft) || draft.roles.length === 0) return;
    mutationPending.current = true;
    setSaving(member.subject);
    setNotice('');
    setSaveErrors((current) => new Map(current).set(member.subject, ''));
    try {
      const result = await api.updateTeamMember({
        subject: member.subject,
        expected: { roles: member.roles, enabled: member.enabled },
        roles: sortRoles(draft.roles),
        enabled: draft.enabled,
      });
      setMembers((current) => current.map((item) => item.subject === member.subject ? result.member : item));
      setDrafts((current) => {
        const next = new Map(current);
        next.delete(member.subject);
        return next;
      });
      setNotice('Membership saved.');
    } catch (error) {
      setSaveErrors((current) => new Map(current).set(member.subject, messageFor(error, 'Changes could not be saved. Try again.')));
    } finally {
      mutationPending.current = false;
      setSaving(null);
    }
  };

  return (
    <main className="min-h-full bg-background-full px-4 py-6 text-text-primary sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-center gap-4">
          <Button variant="ghost" size="small" leadingIcon={RiArrowLeftLine} onClick={onBack}>Back</Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-title-1-medium text-text-primary">Team access</h1>
            <p className="mt-1 text-body-2-regular text-text-secondary">Manage roles for identities already recognized by your SSO provider.</p>
          </div>
          <Button variant="secondary" size="small" leadingIcon={RiRefreshLine} onClick={() => void load()} disabled={loadState === 'loading' || adding || Boolean(saving)}>Refresh</Button>
        </header>
        {notice && <p role="status" className="text-body-2-regular text-text-secondary">{notice}</p>}

        <section aria-labelledby="add-member-heading" className="rounded-3xl border border-border-button-default bg-background-primary-default p-5 shadow-xs sm:p-6">
          <div className="mb-4">
            <h2 id="add-member-heading" className="text-title-3-semibold text-text-primary">Add an SSO identity</h2>
            <p className="mt-1 text-body-2-regular text-text-secondary">Enter the exact subject identifier supplied by your identity provider.</p>
          </div>
          <form onSubmit={(event) => void addMember(event)} className="flex flex-col gap-4">
            <Input
              label="Identity subject"
              inputDir="ltr"
              value={subject}
              onChange={setSubject}
              placeholder="Exact SSO subject identifier"
              isRequired
              maxLength={256}
            />
            <fieldset className="flex flex-col gap-3">
              <legend className="text-body-medium text-text-primary">Roles</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-3">
                {operationalRoles.map((role) => (
                  <Checkbox key={role} isSelected={newRoles.includes(role)} onChange={(selected) => {
                    setNewRoles((current) => selected ? sortRoles([...current, role]) : current.filter((item) => item !== role));
                    setAddError('');
                  }}>{roleLabels[role]}</Checkbox>
                ))}
              </div>
            </fieldset>
            <Checkbox isSelected={newEnabled} onChange={setNewEnabled}>Access enabled</Checkbox>
            {addError && <p role="alert" className="text-body-2-regular text-text-error-primary">{addError}</p>}
            <div>
              <Button type="submit" variant="primary" size="small" leadingIcon={RiUserAddLine} disabled={adding || Boolean(saving) || !subject.trim() || newRoles.length === 0 || loadState !== 'ready'}>
                {adding ? 'Adding…' : 'Add identity'}
              </Button>
            </div>
          </form>
        </section>

        <section aria-labelledby="members-heading" className="rounded-3xl border border-border-button-default bg-background-primary-default p-5 shadow-xs sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="members-heading" className="text-title-3-semibold text-text-primary">Memberships</h2>
              <p className="mt-1 text-body-2-regular text-text-secondary">{members.length} {members.length === 1 ? 'identity' : 'identities'} in this workspace.</p>
            </div>
            <div className="w-full sm:max-w-sm">
              <Input aria-label="Search memberships by subject" placeholder="Search by subject" value={query} onChange={setQuery} />
            </div>
          </div>

          {loadState === 'loading' && <p role="status" className="mt-6 text-body-2-regular text-text-secondary">Loading team memberships…</p>}
          {loadState === 'error' && (
            <div className="mt-6 rounded-2xl border border-border-error-default bg-background-primary-default p-4" role="alert">
              <p className="text-body-2-regular text-text-error-primary">{loadError}</p>
              <Button className="mt-3" variant="secondary" size="small" leadingIcon={RiRefreshLine} onClick={() => void load()}>Try again</Button>
            </div>
          )}
          {loadState === 'ready' && members.length === 0 && (
            <div className="mt-6 rounded-2xl border border-dashed border-border-button-default p-6 text-center">
              <p className="text-body-medium text-text-primary">No team memberships yet</p>
              <p className="mt-1 text-body-2-regular text-text-secondary">Add an existing SSO subject above to grant workspace access.</p>
            </div>
          )}
          {loadState === 'ready' && members.length > 0 && visibleMembers.length === 0 && (
            <p className="mt-6 rounded-2xl bg-background-secondary-default p-4 text-body-2-regular text-text-secondary">No subjects match “{query}”.</p>
          )}
          {loadState === 'ready' && visibleMembers.length > 0 && (
            <ul className="mt-5 flex flex-col divide-y divide-separator-border" aria-label="Team memberships">
              {visibleMembers.map((member) => {
                const draft = drafts.get(member.subject) ?? member;
                const saveError = saveErrors.get(member.subject);
                const immutable = member.roles.includes('admin');
                const dirty = !immutable && !sameDraft(member, draft);
                const busy = saving === member.subject;
                return (
                  <li key={member.subject} className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 lg:w-56">
                      <p className="break-all font-mono text-body-medium text-text-primary" dir="ltr">{member.subject}</p>
                      <p className="mt-1 text-caption-1-regular text-text-tertiary">{immutable ? 'Administrator · managed by your SSO setup' : member.enabled ? 'Access enabled' : 'Access disabled'}</p>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-4">
                      <fieldset disabled={immutable || busy} className="flex flex-wrap gap-x-5 gap-y-3">
                        <legend className="sr-only">Roles for {member.subject}</legend>
                        {member.roles.includes('admin') && <Checkbox isSelected isDisabled>Admin</Checkbox>}
                        {operationalRoles.map((role) => (
                          <Checkbox key={role} isSelected={draft.roles.includes(role)} onChange={(selected) => toggleRole(member, role, selected)}>{roleLabels[role]}</Checkbox>
                        ))}
                        <Checkbox isSelected={draft.enabled} onChange={(selected) => updateDraft(member, { enabled: selected })}>Access enabled</Checkbox>
                      </fieldset>
                      {draft.roles.length === 0 && !immutable && <p className="text-caption-1-regular text-text-error-primary">Choose at least one role before saving.</p>}
                      {saveError && (
                        <div role="alert" className="flex flex-wrap items-center gap-3">
                          <p className="text-body-2-regular text-text-error-primary">{saveError}</p>
                          {saveError.includes('changed elsewhere') && <Button variant="secondary" size="small" onClick={() => void load()}>Reload memberships</Button>}
                        </div>
                      )}
                      {dirty && <div><Button variant="primary" size="small" onClick={() => void saveMember(member)} disabled={adding || Boolean(saving) || draft.roles.length === 0}>{busy ? 'Saving…' : 'Save changes'}</Button></div>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
