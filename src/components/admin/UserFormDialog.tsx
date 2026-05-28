"use client";

import { useState, type ReactNode, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface FormValues {
  name: string;
  email: string;
  password: string;
  role: "admin" | "user";
  org: string;
}

const INITIAL: FormValues = { name: "", email: "", password: "", role: "user", org: "" };

export function UserFormDialog({ open, onOpenChange, onSuccess }: UserFormDialogProps): ReactNode {
  const [values, setValues] = useState<FormValues>(INITIAL);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function field(key: keyof FormValues) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setValues((v) => ({ ...v, [key]: e.target.value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const result = await authClient.admin.createUser({
      name: values.name,
      email: values.email,
      password: values.password,
      role: values.role,
      data: { org: values.org || null },
    });
    setSubmitting(false);
    if (result.error) {
      setError(result.error.message ?? "Failed to create user");
      return;
    }
    setValues(INITIAL);
    onOpenChange(false);
    onSuccess();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New User</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="u-name">Full name</Label>
            <Input id="u-name" value={values.name} onChange={field("name")} required placeholder="Jane Doe" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="u-email">Email</Label>
            <Input id="u-email" type="email" value={values.email} onChange={field("email")} required placeholder="jane@example.com" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="u-password">Password</Label>
            <Input id="u-password" type="password" value={values.password} onChange={field("password")} required minLength={8} placeholder="Min. 8 characters" autoComplete="new-password" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="u-org">Organization / Department</Label>
            <Input id="u-org" value={values.org} onChange={field("org")} placeholder="e.g. Engineering" />
          </div>

          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={values.role} onValueChange={(v) => setValues((prev) => ({ ...prev, role: v as "admin" | "user" }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create User"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
