// A class + an interface, both forwarded by the barrel. Exercises class member
// signatures (public method, static method, getter, public property) and the
// exclusion of private/protected/#private members from the public surface.

export interface ClientOptions {
  baseUrl: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export class ApiClient {
  static readonly defaultTimeout: number = 30_000;

  public readonly baseUrl: string;

  // Non-public members must NOT appear in the surface's member list.
  private token: string | null = null;
  protected retries: number = 3;
  #secret = "hidden";

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl;
  }

  // Public async method with a generic and a typed return.
  async get<T>(path: string): Promise<T> {
    return undefined as unknown as T;
  }

  static create(options: ClientOptions): ApiClient {
    return new ApiClient(options);
  }

  get isAuthenticated(): boolean {
    return this.token !== null;
  }

  // A private method (TS accessibility) -> excluded.
  private buildHeaders(): Record<string, string> {
    return {};
  }
}
