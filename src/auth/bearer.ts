export interface Bearer {
  accessToken(): Promise<string>;

  renew(): Promise<string>;
}

export async function withBearer<Answer extends { status: number }>(auth: Bearer, send: (token: string) => Promise<Answer>): Promise<Answer> {
  const first = await send(await auth.accessToken());
  return first.status === 401 ? send(await auth.renew()) : first;
}
