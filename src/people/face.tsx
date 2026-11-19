import { useState } from "preact/hooks";
import { drawableAvatar, faceInitials, pictureFailed, rememberPicture } from "../shared/review-flow";

export function Face({ src, name, initials }: { src: string | null | undefined; name: string; initials?: string }) {

  const [failed, setFailed] = useState<string | null>(null);
  const photo = drawableAvatar(src);
  const shown = photo !== null && photo !== failed && !pictureFailed(photo) ? photo : null;
  return (
    <span class="specgit-avatar" aria-hidden="true" title={name}>
      {shown ? <img src={shown} alt="" draggable={false} referrerpolicy="no-referrer" onError={() => {
          rememberPicture(shown, "failed");
          setFailed(shown);
        }} /> : (initials ?? faceInitials(name))}
    </span>
  );
}
