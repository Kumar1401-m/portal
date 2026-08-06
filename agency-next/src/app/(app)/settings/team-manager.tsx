"use client";

import { useState } from "react";
import { UserPlus, KeyRound, X, Pencil } from "lucide-react";
import type { TeamMember } from "@/lib/team";
import {
  addTeamMember,
  setTeamMemberActive,
  resetTeamPassword,
  renameTeamMember,
  deleteTeamMember,
} from "./actions";
import { ActionForm } from "./action-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { label } from "@/lib/utils";

/**
 * Settings → Team. Add staff logins, reset a password, and deactivate people
 * who've left. Client logins stay in the Clients module.
 */
export function TeamManager({ team, currentUserId }: { team: TeamMember[]; currentUserId: number }) {
  const [resetting, setResetting] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <ul className="divide-y divide-border rounded-lg border border-border">
          {team.map((m) => (
            <li key={m.id} className="space-y-3 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {m.name}
                    {m.id === currentUserId ? (
                      <span className="text-xs text-muted-foreground">(you)</span>
                    ) : null}
                    <Badge tone={m.is_active ? "success" : "muted"}>
                      {m.is_active ? label(m.role) : "Deactivated"}
                    </Badge>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {m.email} · {m.open_tasks} open task{m.open_tasks === 1 ? "" : "s"}
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setRenaming(renaming === m.id ? null : m.id)}
                    title="Rename"
                    className={buttonClasses({ variant: "ghost", size: "sm" })}
                  >
                    {renaming === m.id ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                    Name
                  </button>
                  <button
                    type="button"
                    onClick={() => setResetting(resetting === m.id ? null : m.id)}
                    title="Reset password"
                    className={buttonClasses({ variant: "ghost", size: "sm" })}
                  >
                    {resetting === m.id ? (
                      <X className="h-4 w-4" />
                    ) : (
                      <KeyRound className="h-4 w-4" />
                    )}
                    Password
                  </button>
                  {m.id === currentUserId ? null : (
                    <>
                      <ActionForm
                        action={setTeamMemberActive}
                        submitLabel={m.is_active ? "Deactivate" : "Reactivate"}
                        size="sm"
                        variant={m.is_active ? "ghost" : "secondary"}
                        confirm={
                          m.is_active
                            ? `Deactivate ${m.name}? They'll be signed out and can't log in.`
                            : undefined
                        }
                      >
                        <input type="hidden" name="id" value={m.id} />
                      </ActionForm>
                      <ActionForm
                        action={deleteTeamMember}
                        submitLabel="Delete"
                        size="sm"
                        variant="destructive"
                        confirm={`Permanently delete ${m.name}? They'll disappear from the portal for good. Their tasks are kept but become unassigned.`}
                      >
                        <input type="hidden" name="id" value={m.id} />
                      </ActionForm>
                    </>
                  )}
                </div>
              </div>

              {renaming === m.id ? (
                <ActionForm
                  action={renameTeamMember}
                  submitLabel="Save name"
                  size="sm"
                  variant="secondary"
                  formClassName="flex flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="id" value={m.id} />
                  <Input
                    name="name"
                    defaultValue={m.name}
                    placeholder="Full name"
                    className="h-9 max-w-xs flex-1"
                  />
                </ActionForm>
              ) : null}

              {resetting === m.id ? (
                <ActionForm
                  action={resetTeamPassword}
                  submitLabel="Set password"
                  size="sm"
                  variant="secondary"
                  resetOnSuccess
                  formClassName="flex flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="id" value={m.id} />
                  <Input
                    name="password"
                    type="text"
                    autoComplete="off"
                    placeholder="Min 8 chars, letters + numbers"
                    className="h-9 max-w-xs flex-1"
                  />
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="rounded-lg border border-border p-4">
          <p className="mb-3 flex items-center gap-2 text-sm font-medium">
            <UserPlus className="h-4 w-4 text-muted-foreground" /> Add a team member
          </p>
          <ActionForm
            action={addTeamMember}
            submitLabel="Add member"
            resetOnSuccess
            formClassName="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end"
          >
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input name="name" placeholder="Full name" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Email</label>
              <Input name="email" type="email" placeholder="name@agency.com" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Role</label>
              <Select name="role" defaultValue="poster_designer">
                <option value="poster_designer">Poster designer</option>
                <option value="video_editor">Video editor</option>
                <option value="crm">CRM</option>
                <option value="admin">Admin</option>
                <option value="super_admin">Super admin</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Password</label>
              <Input name="password" type="text" autoComplete="off" placeholder="Min 8 chars" />
            </div>
          </ActionForm>
        </div>
      </CardContent>
    </Card>
  );
}
