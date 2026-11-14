import { useState } from "react";
import { initialsOf } from "../../services/profileModel";
import "./RiderAvatar.css";

/**
 * A rider's avatar, the same on every page (2026-11-15): their profile photo
 * when the Rider app has one, otherwise up to three initials — the rule staff
 * avatars use (initialsOf: "Ryel Jan Espinili" → "RJE"). The surrounding
 * element keeps each page's own avatar class, so sizes and colours are
 * unchanged. A photo that fails to load falls back to the initials.
 *
 * @param {{ name?: string, photoUrl?: string|null, className?: string }} props
 *   photoUrl comes from profilePhotoUrlOf(riderDoc).
 */
function RiderAvatar({ name = "", photoUrl = null, className = "" }) {
  const [failedUrl, setFailedUrl] = useState(null);
  const showPhoto = Boolean(photoUrl) && failedUrl !== photoUrl;
  return (
    <span className={`${className} rav${showPhoto ? " rav-has-photo" : ""}`.trim()} aria-hidden="true">
      {showPhoto ? (
        <img
          className="rav-photo"
          src={photoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(photoUrl)}
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

export default RiderAvatar;
