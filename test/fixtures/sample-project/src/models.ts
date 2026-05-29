// Clean module with a representative spread of symbol kinds.

export interface User {
  id: string;
  name: string;
  getDisplayName(): string;
}

export type UserId = string;

export enum Role {
  Admin = "admin",
  Member = "member",
  Guest = "guest"
}

export const DEFAULT_ROLE: Role = Role.Guest;

let internalCounter = 0;

export function nextId(): string {
  internalCounter += 1;
  return `u_${internalCounter}`;
}

export class UserService {
  private readonly users: Map<string, User> = new Map();

  static create(): UserService {
    return new UserService();
  }

  add(user: User): void {
    this.users.set(user.id, user);
  }

  get count(): number {
    return this.users.size;
  }

  async findById(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }
}

function unexportedHelper(): boolean {
  return internalCounter > 0;
}

export default UserService;
