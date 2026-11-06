/** ACP uses one JSON-RPC message per line, including bidirectional requests. */
export type AcpObject = Record<string, any>;
export type AcpTransport = {
  write: (line: string) => void | Promise<void>;
  kill: () => void;
};

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

export class AcpConnection {
  private buffer = "";
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: AcpObject) => void;
      reject: (reason: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private sessions = new Map<
    string,
    {
      update: (update: AcpObject) => void;
      permission: (request: AcpObject) => Promise<AcpObject>;
    }
  >();
  private closeListeners = new Set<(error: Error) => void>();
  closed = false;

  constructor(private readonly transport: AcpTransport) {}

  request(
    method: string,
    params: AcpObject,
    timeoutMs = 60_000,
  ): Promise<AcpObject> {
    if (this.closed)
      return Promise.reject(new AcpError("DSH connection is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new AcpError(
                  `DSH ${method} timed out after ${timeoutMs / 1000}s`,
                ),
              );
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: AcpObject): void {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, params });
  }

  subscribe(
    sessionId: string,
    handlers: {
      update: (update: AcpObject) => void;
      permission: (request: AcpObject) => Promise<AcpObject>;
    },
  ): () => void {
    if (this.sessions.has(sessionId))
      throw new AcpError("DSH session is already running");
    this.sessions.set(sessionId, handlers);
    return () => this.sessions.delete(sessionId);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    // Bound an unterminated or malicious frame without limiting the transcript.
    if (this.buffer.length > 32 * 1024 * 1024) {
      this.close(new AcpError("DSH ACP message exceeds 32 MB"));
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (
          !message ||
          message.jsonrpc !== "2.0" ||
          typeof message !== "object"
        ) {
          throw new AcpError("Invalid DSH JSON-RPC envelope");
        }
        this.dispatch(message);
      } catch {
        this.close(new AcpError("Invalid DSH ACP stream"));
        return;
      }
    }
  }

  private send(message: AcpObject): void {
    try {
      Promise.resolve(
        this.transport.write(JSON.stringify(message) + "\n"),
      ).catch((error) =>
        this.close(new AcpError(`DSH stdin failed: ${String(error)}`)),
      );
    } catch (error) {
      this.close(new AcpError(`DSH stdin failed: ${String(error)}`));
    }
  }

  private dispatch(message: AcpObject): void {
    if (typeof message.method !== "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return; // A timed-out reply cannot complete a later request.
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new AcpError(
            String(message.error.message || "DSH request failed"),
            message.error.code,
          ),
        );
      else if ("result" in message) pending.resolve(message.result || {});
      else pending.reject(new AcpError("DSH response has no result or error"));
      return;
    }
    const params = message.params || {};
    const session = this.sessions.get(params.sessionId);
    if (message.id === undefined) {
      if (message.method === "session/update" && session)
        session.update(params.update || {});
      return;
    }
    if (message.method === "session/request_permission") {
      void Promise.resolve()
        .then(
          () =>
            session?.permission(params) || {
              outcome: { outcome: "cancelled" },
            },
        )
        .catch(() => ({ outcome: { outcome: "cancelled" } }))
        .then((result) => {
          if (!this.closed)
            this.send({ jsonrpc: "2.0", id: message.id, result });
        });
    } else {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Client method not supported: ${message.method}`,
        },
      });
    }
  }

  close(
    error = new AcpError("DSH process exited; this turn was interrupted"),
  ): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.sessions.clear();
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
    this.transport.kill();
  }
}

export function validateDshCapabilities(result: AcpObject): AcpObject {
  const caps = result.agentCapabilities;
  if (result.protocolVersion !== 1)
    throw new AcpError(
      "DSH must support ACP protocol version 1. Update DSH and retry.",
    );
  if (!caps?.mcpCapabilities?.http)
    throw new AcpError(
      "DSH does not support HTTP MCP. Update DSH to use Zotero tools.",
    );
  if (!caps.sessionCapabilities?.resume || !caps.sessionCapabilities?.close) {
    throw new AcpError(
      "DSH must support session/resume and session/close. Update DSH and retry.",
    );
  }
  return caps;
}

export type AcpConfigOption = {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string;
  options: Array<
    | { value: string; name: string }
    | { group: string; options: Array<{ value: string; name: string }> }
  >;
};

export function configChoices(
  option?: AcpConfigOption,
): Array<{ value: string; name: string }> {
  return (option?.options || []).flatMap((entry) =>
    "options" in entry ? entry.options : [entry],
  );
}
