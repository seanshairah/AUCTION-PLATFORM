'use client';

import { CameraIcon, VideoCameraIcon } from '@heroicons/react/20/solid';
import { useState } from 'react';

export interface GalleryPhoto {
  url: string;
  role: string;
}

/** Main photo with a thumbnail column; the last thumbnail counts the rest of the standard set. */
export function Gallery({ photos, total, hasVideo, title }: { photos: GalleryPhoto[]; total: number; hasVideo: boolean; title: string }) {
  const [i, setI] = useState(0);
  const shown = photos.slice(0, 4);
  const current = photos[i] ?? photos[0];
  return (
    <div className="gallery">
      <div className="main">
        {current && <img src={`${current.url}${current.url.startsWith('/media/') ? '?w=1600' : ''}`} alt={`${title}: ${current.role.replaceAll('_', ' ')}`} />}
        <div className="tags">
          <span className="tag dark"><CameraIcon /> {total} photos</span>
          {hasVideo && <span className="tag dark"><VideoCameraIcon /> Walk-around video</span>}
          {current && <span className="tag">{current.role.replaceAll('_', ' ')}</span>}
        </div>
      </div>
      <div className="thumbs">
        {shown.map((p, n) => (
          <button key={p.url + n} type="button" className={`thumb${n === i ? ' on' : ''}`} onClick={() => setI(n)} aria-label={`Show ${p.role.replaceAll('_', ' ')}`}>
            <img src={`${p.url}${p.url.startsWith('/media/') ? '?w=800' : ''}`} alt="" loading="lazy" />
          </button>
        ))}
        {total > shown.length && <div className="thumb more">+{total - shown.length}<br />in report</div>}
      </div>
    </div>
  );
}
