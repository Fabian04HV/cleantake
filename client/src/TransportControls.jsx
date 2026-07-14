import Icon from "./Icon.jsx";
import skipPreviousIconSvg from "./icons/skip_previous_24dp_E3E3E3_FILL1_wght300_GRAD0_opsz24.svg?raw";
import replay5IconSvg from "./icons/replay_5_24dp_E3E3E3_FILL1_wght300_GRAD0_opsz24.svg?raw";
import playIconSvg from "./icons/play_arrow_24dp_E3E3E3_FILL1_wght300_GRAD0_opsz24.svg?raw";
import pauseIconSvg from "./icons/pause_24dp_E3E3E3_FILL1_wght300_GRAD0_opsz24.svg?raw";
import forward5IconSvg from "./icons/forward_5_24dp_E3E3E3_FILL1_wght300_GRAD0_opsz24.svg?raw";
import skipNextIconSvg from "./icons/skip_next_24dp_E3E3E3_FILL1_wght300_GRAD0_opsz24.svg?raw";

const SEEK_STEP_SECONDS = 5;

// Presentational transport *buttons* only - the edited/source time labels are
// rendered separately (see WaveformEditor's toolbar, left column) so the
// waveform header can lay out as left: time, middle: these buttons, right:
// zoom. It never owns playback state itself - every value and action comes
// straight from the shared useEditedPlayback controller, so the Space
// shortcut, every button here, and any future control surface all stay
// perfectly in sync.
function TransportControls({
  isPlaying,
  editedDuration,
  sourceDuration,
  onTogglePlayback,
  seekToStart,
  seekBy,
  seekToEnd,
  disabled,
}) {
  // No playable position exists yet (nothing loaded, duration not known
  // yet, or the user has excluded every last second) - every cursor button
  // is disabled together, never just some of them.
  const hasDuration = Number.isFinite(sourceDuration) && sourceDuration > 0;
  const hasPlayableAudio = Number.isFinite(editedDuration) ? editedDuration > 0 : true;
  const controlsDisabled = disabled || !hasDuration || !hasPlayableAudio;

  return (
    <div className="transport-controls">
      <div className="transport-icon-controls">
        <button
          type="button"
          className="playback-icon-button"
          onClick={seekToStart}
          disabled={controlsDisabled}
          aria-label="Go to start"
          title="Go to start"
        >
          <Icon svg={skipPreviousIconSvg} />
        </button>
        <button
          type="button"
          className="playback-icon-button"
          onClick={() => seekBy(-SEEK_STEP_SECONDS)}
          disabled={controlsDisabled}
          aria-label={`Skip back ${SEEK_STEP_SECONDS} seconds`}
          title={`Skip back ${SEEK_STEP_SECONDS} seconds`}
        >
          <Icon svg={replay5IconSvg} />
        </button>
        <button
          type="button"
          className="playback-icon-button playback-icon-button--primary"
          onClick={onTogglePlayback}
          disabled={controlsDisabled}
          aria-label={isPlaying ? "Pause" : "Play"}
          title={isPlaying ? "Pause" : "Play"}
        >
          <Icon
            svg={isPlaying ? pauseIconSvg : playIconSvg}
            className={isPlaying ? "icon--pause" : "icon--play"}
          />
        </button>
        <button
          type="button"
          className="playback-icon-button"
          onClick={() => seekBy(SEEK_STEP_SECONDS)}
          disabled={controlsDisabled}
          aria-label={`Skip forward ${SEEK_STEP_SECONDS} seconds`}
          title={`Skip forward ${SEEK_STEP_SECONDS} seconds`}
        >
          <Icon svg={forward5IconSvg} />
        </button>
        <button
          type="button"
          className="playback-icon-button"
          onClick={seekToEnd}
          disabled={controlsDisabled}
          aria-label="Go to end"
          title="Go to end"
        >
          <Icon svg={skipNextIconSvg} />
        </button>
      </div>
    </div>
  );
}

export default TransportControls;
