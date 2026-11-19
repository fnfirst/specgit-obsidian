import type { DocumentRef } from "../mapping";
import { type Bearer, withBearer } from "./bearer";
import { GIT_PROVIDER, NOTE_BRANCH, normalizeServer, VERSION_HEADER } from "./config";
import { jsonObject, type Transport } from "./transport";

export interface RoomPeopleOptions {
  server: string;
  version: string;
  auth: Bearer;
  transport: Transport;
}

export class SpecgitRoomPeople {
  private readonly server: string;

  constructor(private readonly options: RoomPeopleOptions) {
    this.server = normalizeServer(options.server);
  }

  async read(doc: DocumentRef): Promise<number | null> {
    const [owner, repo, ...rest] = doc.repo.split("/");
    if (!owner || !repo || rest.length > 0) return null;
    const query = new URLSearchParams({ provider: GIT_PROVIDER, owner, repo, branch: NOTE_BRANCH, path: doc.path });
    try {
      const response = await withBearer(this.options.auth, (token) =>
        this.options.transport({
          url: `${this.server}/api/realtime/people?${query.toString()}`,
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, [VERSION_HEADER]: this.options.version },
        }),
      );
      const people = response.status === 200 ? jsonObject(response.text)?.people : undefined;
      return typeof people === "number" && Number.isInteger(people) && people >= 0 ? people : null;
    } catch {
      return null;
    }
  }
}
