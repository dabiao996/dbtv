import React from 'react';
import {playbackLoadingState} from './playback-loading-state';

export default function PlaybackLoading({stage}:{stage:string}){
  const {failed,hint}=playbackLoadingState(stage);
  return <div className={'player-loading'+(failed?' is-error':'')} role="status" aria-live="polite" aria-atomic="true">
    <div className="player-loading-card">
      <div className="player-loading-orbit" aria-hidden="true">
        <svg viewBox="0 0 80 80" className="player-loading-ring"><circle className="player-loading-track" cx="40" cy="40" r="36"/><circle className="player-loading-arc" cx="40" cy="40" r="36"/></svg>
        <img src="/images/dabiao-icon.svg" alt="" width="48" height="48"/>
        {failed&&<span className="player-loading-alert">!</span>}
      </div>
      <span className="player-loading-brand" aria-hidden="true">DABIAO TV</span>
      <b>{stage}</b><small>{hint}</small>
      {!failed&&<div className="player-loading-dots" aria-hidden="true"><i/><i/><i/></div>}
    </div>
  </div>;
}
