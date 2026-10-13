import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The one line a web developer pastes before </body> on each allowed website (Phase 20e). */
export function WebChatEmbed({ snippet, enabled }: { snippet: string | null; enabled: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add the chat to your website</CardTitle>
        <CardDescription>
          Paste this line before the closing &lt;/body&gt; tag of each page, on the websites listed
          above only. The button appears once the chat is switched on.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {snippet ? (
          <code className="bg-muted block overflow-x-auto rounded px-2 py-1 text-xs whitespace-pre">
            {snippet}
          </code>
        ) : (
          <p className="text-muted-foreground text-sm">Save the settings first to get the code.</p>
        )}
        {!enabled && snippet && (
          <p className="text-muted-foreground text-xs">
            The chat is off: the button will not show yet.
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          Visitors are identified by a random code kept in their own browser (no cookie). Their
          messages arrive in the Inbox under &lsquo;Website chat&rsquo;; replies are text only.
        </p>
      </CardContent>
    </Card>
  );
}
