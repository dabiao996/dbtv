import {useLayoutEffect} from 'react';
import {useLocation} from 'react-router-dom';

export default function NavigationScroll(){
  const location=useLocation();
  useLayoutEffect(()=>{
    // A same-page Link still gets a new location key. Reset both viewport
    // and body scrolling: the public layout can make body the scroll container.
    window.scrollTo({top:0,left:0,behavior:'instant'});
    document.documentElement.scrollTo({top:0,left:0,behavior:'instant'});
    document.body.scrollTo({top:0,left:0,behavior:'instant'});
  },[location.key]);
  useLayoutEffect(()=>{
    const clear=()=>document.querySelectorAll<HTMLVideoElement>('video[controls]').forEach(video=>{const list=(video.getAttribute('controlsList')||'').split(/\s+/).filter(Boolean);if(list.includes('nofullscreen')){const next=list.filter(token=>token!=='nofullscreen');if(next.length)video.setAttribute('controlsList',next.join(' '));else video.removeAttribute('controlsList')}});
    clear();const observer=new MutationObserver(clear);observer.observe(document.body,{subtree:true,childList:true});return()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>{
    const addName=()=>{document.querySelectorAll<HTMLElement>('.user-menu:not([data-name-bound])').forEach(menu=>{menu.dataset.nameBound='true';const button=menu.querySelector('button');if(!button)return;fetch('/api/auth/me',{credentials:'include'}).then(r=>r.ok?r.json():null).then(user=>{if(!user||button.querySelector('.user-menu-name'))return;const name=document.createElement('strong');name.className='user-menu-name';name.textContent=user.displayName||user.username;button.insertBefore(name,button.lastElementChild)}).catch(()=>{})});document.querySelectorAll<HTMLElement>('.detail-poster:not([data-play-bound])').forEach(poster=>{poster.dataset.playBound='true';poster.addEventListener('click',()=>{(document.querySelector('.detail-actions .play-button') as HTMLAnchorElement|null)?.click()})});};
    addName();const observer=new MutationObserver(addName);observer.observe(document.body,{subtree:true,childList:true});return()=>observer.disconnect();
  },[]);
  return null;
}
