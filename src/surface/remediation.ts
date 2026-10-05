/**
 * The UI layer's half of the error model (plan §6): every catalog remediation
 * id maps to the concrete step the plan's action table promises, and — where
 * the editor can perform that step — to the command that performs it. The
 * catalog stays wording-free: it names the action, this module speaks it.
 *
 * Pure data on purpose: commands arrive as ids and arguments and are run by
 * the surface, so the mapping is unit-testable without the VS Code API and the
 * buttons cannot silently drift from the ids the manifest contributes.
 */
import type { BetelgeuzError, Phase, RemediationId } from "../errors";

export type RemediationButton = {
  /** Button label, phrased as the step it performs. */
  label: string;
  command: string;
  args?: Array<unknown>;
  /** Offer the button only while this extension is installed. */
  requiresExtension?: string;
};

export type Remediation = {
  /** The one concrete step (plan §6: "one concrete remediation action").
   *  Empty when the button alone says it — "Try Again" needs no caption. */
  advice: string;
  /** A button that performs the step, when the editor can perform it. When
   *  absent the step is the user's or the target's to take and the advice is
   *  all the toast offers. */
  button?: RemediationButton;
  /** The step is to run the failed command again; the surface supplies the
   *  button from the handler it already holds. */
  retry?: boolean;
};

const PROFILE_SETTINGS: RemediationButton = {
  label: "Open Settings",
  command: "workbench.action.openSettings",
  args: ["betelgeuz.profiles"],
};

const SELECT_TARGET: RemediationButton = {
  label: "Select SSH Target",
  command: "betelgeuz.selectSshTarget",
};

const ACTIONS: Record<RemediationId, Remediation> = {
  upgradeFrontend: {
    advice: "Upgrade the Betelgeuz extension so the frontend and the core speak the same protocol.",
    button: { label: "Open Extensions View", command: "workbench.view.extensions" },
  },
  checkProfileSettings: {
    advice: "Check the Betelgeuz profile settings.",
    button: PROFILE_SETTINGS,
  },
  fixProxySettings: {
    advice: "Fix the profile's proxy settings.",
    button: PROFILE_SETTINGS,
  },
  openSettings: {
    advice: "Open the setting and correct the value.",
    button: {
      label: "Open Setting",
      command: "workbench.action.openSettings",
      args: ["betelgeuz"],
    },
  },
  checkNetworkAndSshService: {
    advice: "Check the network and the SSH service on the target.",
    retry: true,
  },
  checkCredentials: {
    advice: "Check the user and key credentials.",
    button: PROFILE_SETTINGS,
  },
  checkAlgorithms: {
    advice: "Check the client and server algorithm configuration.",
  },
  checkHostKeyPin: {
    advice: "Compare the fingerprints and review the pin.",
    button: PROFILE_SETTINGS,
  },
  retry: {
    advice: "",
    retry: true,
  },
  checkIdentityPins: {
    advice: "Review the pins, or choose another board.",
    button: SELECT_TARGET,
  },
  rebindAttach: {
    advice: "Re-run Select SSH Target to bind this workspace again.",
    button: SELECT_TARGET,
  },
  buildWithCMakeTools: {
    advice: "Build the target with CMake Tools first — Betelgeuz never builds.",
    button: {
      label: "Build with CMake Tools",
      command: "cmake.build",
      requiresExtension: "ms-vscode.cmake-tools",
    },
  },
  checkArtifactToolchain: {
    advice: "Check the toolchain and core selection.",
  },
  deploySingleArtifact: {
    advice: "Deploy a target that produces a single artifact.",
    button: {
      label: "Open Deploy Settings",
      command: "workbench.action.openSettings",
      args: ["betelgeuz.deploy.localTarget"],
    },
  },
  selectSupportedStrategy: {
    advice: "Select a strategy the target supports.",
    button: SELECT_TARGET,
  },
  retryLater: {
    advice: "",
    retry: true,
  },
  none: {
    advice: "",
  },
  restorePreviousVersion: {
    advice: "Restore the previous version retained on the target.",
  },
  checkPrivileges: {
    advice: "Check the account's privilege mode and the sudo whitelist.",
  },
  upgradeTargetSftpServer: {
    advice: "Use a target SFTP server that supports posix-rename, such as OpenSSH.",
  },
  installCmakeTools: {
    advice: "Install the CMake Tools extension.",
    button: { label: "Open Extensions View", command: "workbench.view.extensions" },
  },
  installGdbserver: {
    advice: "Install gdbserver on the target, or copy a transient static one over.",
  },
  inspectTrace: {
    advice: "Inspect the trace output.",
    button: { label: "View Logs", command: "betelgeuz.logs" },
  },
  showLog: {
    advice: "Open the output for the raw transport detail.",
  },
};

/**
 * The remediation for an error. `config.invalid` is special: its advice points
 * at the offending key, which the setting-error detail names, so the button
 * opens Settings on that key rather than on the namespace at large.
 */
export function remediationFor(error: BetelgeuzError): Remediation {
  const base = ACTIONS[error.remediation];
  if (error.remediation !== "openSettings") {
    return base;
  }
  const key = /^\s*(betelgeuz\.[A-Za-z0-9.]+)/.exec(error.detail ?? "")?.[1];
  return key === undefined
    ? base
    : {
        ...base,
        button: {
          label: "Open Setting",
          command: "workbench.action.openSettings",
          args: [key],
        },
      };
}

/**
 * The phase label a failure is announced with (plan §7: "User-facing errors
 * should identify the failed phase"), in the wording of the plan's own
 * presentation model — resolve profile, connect, verify identity, deploy,
 * lifecycle — so a failure reads like the Remote-SSH output the target user
 * already knows.
 */
export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "profile":
      return "resolve profile";
    case "config":
      return "check settings";
    case "connect":
      return "connect";
    case "identity":
      return "verify identity";
    case "inspect":
      return "inspect target";
    case "artifact":
      return "resolve artifact";
    case "deploy":
      return "deploy";
    case "lifecycle":
      return "target lifecycle";
    case "debug":
      return "debug";
  }
}
