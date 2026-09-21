import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/Field";

export type ClientEmailOption = {
  id: string;
  displayName: string;
  email?: string | null;
  clientNumber?: string | null;
};

type Props = {
  value: string;
  onChange: (email: string, client?: ClientEmailOption) => void;
  disabled?: boolean;
};

function matches(client: ClientEmailOption, q: string): boolean {
  const hay = [
    client.displayName,
    client.email ?? "",
    client.clientNumber ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

export function ClientEmailCombobox({ value, onChange, disabled }: Props) {
  const [clients, setClients] = useState<ClientEmailOption[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void api<ClientEmailOption[]>("/api/clients")
      .then(setClients)
      .catch(() => setClients([]));
  }, []);

  const q = value.trim().toLowerCase();
  const results = useMemo(() => {
    const withEmail = clients.filter((c) => c.email);
    if (!q) return withEmail.slice(0, 12);
    return withEmail.filter((c) => matches(c, q)).slice(0, 12);
  }, [clients, q]);

  const looksLikeEmail = value.includes("@");

  return (
    <div className="relative">
      <Input
        type="text"
        autoComplete="off"
        disabled={disabled}
        value={value}
        placeholder="Client, n°, ou adresse email"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && !disabled && (results.length > 0 || looksLikeEmail) ? (
        <div className="z-20 overflow-hidden border border-[var(--border)] bg-[var(--surface)] shadow-lg max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[50vh] max-sm:rounded-t-[var(--radius-lg)] max-sm:pb-[env(safe-area-inset-bottom)] sm:absolute sm:mt-1 sm:w-full sm:rounded-lg">
          <Command shouldFilter={false}>
            <Command.List className="max-h-[50vh] overflow-y-auto p-1 sm:max-h-56">
              {results.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`${c.id} ${c.email}`}
                  className="flex min-h-12 cursor-pointer flex-col justify-center rounded-md px-3 py-3 text-sm data-[selected=true]:bg-[var(--primary-soft)]"
                  onMouseDown={(e) => e.preventDefault()}
                  onSelect={() => {
                    onChange(c.email ?? "", c);
                    setOpen(false);
                  }}
                >
                  <span className="font-medium">{c.displayName}</span>
                  <span className="text-xs text-[var(--muted)]">
                    {c.clientNumber ? `${c.clientNumber} · ` : ""}
                    {c.email}
                  </span>
                </Command.Item>
              ))}
              {results.length === 0 && looksLikeEmail ? (
                <Command.Item
                  value={value}
                  className="rounded-md px-2.5 py-2 text-sm text-[var(--muted)]"
                  onMouseDown={(e) => e.preventDefault()}
                  onSelect={() => setOpen(false)}
                >
                  Utiliser {value}
                </Command.Item>
              ) : null}
            </Command.List>
          </Command>
        </div>
      ) : null}
    </div>
  );
}
