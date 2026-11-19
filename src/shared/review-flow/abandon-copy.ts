export function abandonCommentsSentence(reviews: number, noun: "document" | "file"): string {
  return reviews === 1
    ? `Comments started in this review are marked resolved on GitHub; open comments from earlier reviews continue on the ${noun}'s next review.`
    : "Comments started in these reviews are marked resolved on GitHub; open comments from earlier reviews continue on each file's next review.";
}
