import type { VoiceAudioRoute, VoiceAudioRouteKind } from "@t3tools/client-runtime/voice";
import type {
  T3VoiceAudioRoutePreferenceState,
  T3VoiceNativeModule,
} from "@t3tools/mobile-voice-native";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { requestOptionalBluetoothPermission } from "./requestOptionalBluetoothPermission";
import { voiceErrorMessage as errorMessage } from "./voiceError";

const ROUTE_KIND_LABEL: Readonly<Record<VoiceAudioRouteKind, string>> = {
  system: "System default",
  speaker: "Speaker",
  earpiece: "Phone",
  bluetooth: "Bluetooth",
  wired: "Wired headset",
};

export interface VoiceAudioRoutePreferencePresentation {
  readonly valueLabel: string;
  readonly statusMessage: string | null;
}

export function presentVoiceAudioRoutePreference(
  state: T3VoiceAudioRoutePreferenceState | null,
  input: {
    readonly nativeAvailable: boolean;
    readonly loading: boolean;
    readonly error: string | null;
  },
): VoiceAudioRoutePreferencePresentation {
  if (!input.nativeAvailable) {
    return {
      valueLabel: "Unavailable",
      statusMessage: "This build has no native voice runtime.",
    };
  }
  if (state === null) {
    return {
      valueLabel: input.loading ? "Loading…" : "Unavailable",
      statusMessage: input.error,
    };
  }

  const preferred = state.routes.find((route) => route.kind === state.preferredRoute);
  const active =
    state.activeRoute === null
      ? null
      : state.routes.find((route) => route.kind === state.activeRoute);
  if (preferred === undefined) {
    return {
      valueLabel: `${ROUTE_KIND_LABEL[state.preferredRoute]} (unavailable)`,
      statusMessage:
        active === undefined || active === null
          ? "Your preferred audio route is unavailable. Android will use the system default."
          : `Your preferred audio route is unavailable. Android is using ${active.label}.`,
    };
  }
  if (active !== null && active !== undefined && active.kind !== preferred.kind) {
    return {
      valueLabel: preferred.label,
      statusMessage: `Android is currently using ${active.label}.`,
    };
  }
  return { valueLabel: preferred.label, statusMessage: null };
}

export interface VoiceAudioRoutePreferenceController {
  readonly nativeAvailable: boolean;
  readonly visible: boolean;
  readonly loading: boolean;
  readonly selectingRoute: VoiceAudioRouteKind | null;
  readonly state: T3VoiceAudioRoutePreferenceState | null;
  readonly error: string | null;
  readonly valueLabel: string;
  readonly statusMessage: string | null;
  readonly open: () => void;
  readonly close: () => void;
  readonly refresh: () => Promise<void>;
  readonly select: (route: VoiceAudioRoute) => void;
}

export function useVoiceAudioRoutePreferenceController(
  native: T3VoiceNativeModule | null,
): VoiceAudioRoutePreferenceController {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectingRoute, setSelectingRoute] = useState<VoiceAudioRouteKind | null>(null);
  const [state, setState] = useState<T3VoiceAudioRoutePreferenceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    if (native === null) {
      setLoading(false);
      setState(null);
      setError("This build has no native voice runtime.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await native.getAudioRoutePreferenceAsync();
      if (requestSequence !== requestSequenceRef.current) return;
      setState(next);
    } catch (cause) {
      if (requestSequence !== requestSequenceRef.current) return;
      setError(errorMessage(cause));
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, [native]);

  const open = useCallback(() => {
    setVisible(true);
    if (native === null) {
      void refresh();
      return;
    }
    void requestOptionalBluetoothPermission(native).then(refresh);
  }, [native, refresh]);

  const close = useCallback(() => {
    setVisible(false);
    setSelectingRoute(null);
  }, []);

  useEffect(() => {
    if (native === null) return;
    const subscription = native.addListener("audioRoutePreferenceChanged", (next) => {
      requestSequenceRef.current += 1;
      setState(next);
      setError(null);
      setLoading(false);
    });
    void refresh();
    return () => {
      requestSequenceRef.current += 1;
      subscription.remove();
    };
  }, [native, refresh]);

  const select = useCallback(
    (route: VoiceAudioRoute) => {
      if (native === null || selectingRoute !== null || route.kind === state?.preferredRoute)
        return;
      setSelectingRoute(route.kind);
      setError(null);
      const requestSequence = ++requestSequenceRef.current;
      void native
        .setAudioRoutePreferenceAsync({ route: route.kind })
        .then((next) => {
          if (requestSequence !== requestSequenceRef.current) return;
          setState(next);
        })
        .catch((cause) => {
          if (requestSequence !== requestSequenceRef.current) return;
          setError(errorMessage(cause));
        })
        .finally(() => {
          setSelectingRoute((current) => (current === route.kind ? null : current));
        });
    },
    [native, selectingRoute, state?.preferredRoute],
  );

  const { valueLabel, statusMessage } = presentVoiceAudioRoutePreference(state, {
    nativeAvailable: native !== null,
    loading,
    error,
  });

  return useMemo(
    () => ({
      nativeAvailable: native !== null,
      visible,
      loading,
      selectingRoute,
      state,
      error,
      valueLabel,
      statusMessage,
      open,
      close,
      refresh,
      select,
    }),
    [
      close,
      error,
      loading,
      native,
      open,
      refresh,
      select,
      selectingRoute,
      state,
      statusMessage,
      valueLabel,
      visible,
    ],
  );
}

const VoiceAudioRoutePreferenceContext = createContext<VoiceAudioRoutePreferenceController | null>(
  null,
);

export function VoiceAudioRoutePreferenceProvider(props: {
  readonly value: VoiceAudioRoutePreferenceController;
  readonly children: ReactNode;
}) {
  return (
    <VoiceAudioRoutePreferenceContext.Provider value={props.value}>
      {props.children}
    </VoiceAudioRoutePreferenceContext.Provider>
  );
}

export function useVoiceAudioRoutePreference(): VoiceAudioRoutePreferenceController {
  const context = use(VoiceAudioRoutePreferenceContext);
  if (context === null) {
    throw new Error(
      "useVoiceAudioRoutePreference must be used inside VoiceAudioRoutePreferenceProvider",
    );
  }
  return context;
}
