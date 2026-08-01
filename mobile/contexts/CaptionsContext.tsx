import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const CAPTIONS_KEY = "argus_captions_enabled";

type CaptionsContextValue = {
  captionsEnabled: boolean;
  setCaptionsEnabled: (enabled: boolean) => void;
};

const CaptionsContext = createContext<CaptionsContextValue | null>(null);

// Default is off — onboarding lets the user opt in, and Settings can change
// it anytime after. Existing installs that already stored a value (from
// before this was opt-in) keep whatever they had.
export function CaptionsProvider({ children }: { children: ReactNode }) {
  const [captionsEnabled, setEnabled] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(CAPTIONS_KEY).then(v => { if (v !== null) setEnabled(v === "1"); });
  }, []);

  function setCaptionsEnabled(enabled: boolean) {
    setEnabled(enabled);
    AsyncStorage.setItem(CAPTIONS_KEY, enabled ? "1" : "0");
  }

  return (
    <CaptionsContext.Provider value={{ captionsEnabled, setCaptionsEnabled }}>
      {children}
    </CaptionsContext.Provider>
  );
}

export function useCaptions() {
  const ctx = useContext(CaptionsContext);
  if (!ctx) throw new Error("useCaptions must be used within CaptionsProvider");
  return ctx;
}
