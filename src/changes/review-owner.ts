export function isAnotherAuthor(author: string | null | undefined, viewer: string): boolean {
  return author == null || author.toLowerCase() !== viewer.toLowerCase();
}
