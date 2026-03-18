export interface GmailMessage { id: string; subject: string; from: string; snippet: string; date: string; }

export async function fetchUnreadEmails(token: string, max = 5): Promise<GmailMessage[]> {
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";
  const hdr = { Authorization: "Bearer " + token };
  const listRes = await fetch(base + "/messages?q=is:unread&maxResults=" + max, { headers: hdr });
  const list = await listRes.json();
  if (!list.messages) return [];
  const msgs = await Promise.all(list.messages.map(async (m: any) => {
    const r = await fetch(base + "/messages/" + m.id + "?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date", { headers: hdr });
    const d = await r.json();
    const h = (name: string) => d.payload?.headers?.find((x:any) => x.name===name)?.value || "";
    return { id: m.id, subject: h("Subject"), from: h("From"), snippet: d.snippet || "", date: h("Date") };
  }));
  return msgs;
}
