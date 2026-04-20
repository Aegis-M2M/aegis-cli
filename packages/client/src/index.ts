export interface AegisClientOptions {
  /** The URL of the local Aegis Daemon. Defaults to http://localhost:23447 */
  daemonUrl?: string;
}

export interface ExecuteParams<T = any> {
  /** The registered ID of the service */
  service: string;
  /** The JSON payload expected by the service */
  request: T;
  /** Optional: The maximum number of credits you are willing to spend */
  maxCredits?: number;
}

export interface AegisBilling {
  credits_charged: number;
  credit_balance: number;
}

export interface AegisResponse<T = any> {
  data: T;
  aegis_billing: AegisBilling;
}

export class AegisError extends Error {
  public status?: number;
  /**
   * The raw JSON body returned by the daemon on an error response, if any.
   * Useful for inspecting structured error fields (e.g. `required`, `maxCredits`).
   */
  public body?: any;
  constructor(message: string, status?: number, body?: any) {
    super(message);
    this.name = "AegisError";
    this.status = status;
    this.body = body;
  }
}

export class AegisClient {
  private daemonUrl: string;

  constructor(options?: AegisClientOptions) {
    this.daemonUrl = options?.daemonUrl?.replace(/\/$/, "") || "http://localhost:23447";
  }

  async status() {
    try {
      const res = await fetch(`${this.daemonUrl}/api/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err: any) {
      throw new AegisError(`Failed to reach Aegis Daemon at ${this.daemonUrl}. Is the CLI running? Details: ${err.message}`);
    }
  }

  async execute<ResponseType = any, RequestType = any>(
    params: ExecuteParams<RequestType>
  ): Promise<AegisResponse<ResponseType>> {
    try {
      const payload: any = {
        service: params.service,
        request: params.request,
      };

      if (params.maxCredits !== undefined) {
        payload.maxCredits = params.maxCredits;
      }

      const res = await fetch(`${this.daemonUrl}/v1/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errorMsg = data.error || data.message || `HTTP ${res.status}`;
        throw new AegisError(
          `Aegis Execution Failed: ${errorMsg}`,
          res.status,
          data,
        );
      }

      return data as AegisResponse<ResponseType>;
    } catch (err: any) {
      if (err instanceof AegisError) throw err;
      throw new AegisError(`Network error reaching Aegis Daemon: ${err.message}`);
    }
  }
}
