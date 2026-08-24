"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import type { ModalPayload, ModalType } from "@/components/providers/modal-types";

export type { ModalPayload, ModalType };

type ModalState = {
  type: ModalType;
  payload: ModalPayload;
};

type ModalContextValue = {
  openModal: (type: Exclude<ModalType, null>, payload?: ModalPayload) => void;
  closeModal: () => void;
  type: ModalType;
  payload: ModalPayload;
};

const ModalContext = createContext<ModalContextValue | null>(null);

export function useModal() {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error("useModal doit être utilisé dans ModalProvider");
  return ctx;
}

const ModalHost = dynamic(() => import("@/components/providers/modal-host"), {
  ssr: false,
});

export function ModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ModalState>({ type: null, payload: {} });
  const [hostReady, setHostReady] = useState(false);

  const openModal = useCallback((type: Exclude<ModalType, null>, payload: ModalPayload = {}) => {
    setHostReady(true);
    setState({ type, payload });
  }, []);

  const closeModal = useCallback(() => {
    setState({ type: null, payload: {} });
  }, []);

  const value = useMemo(
    () => ({ openModal, closeModal, type: state.type, payload: state.payload }),
    [openModal, closeModal, state.type, state.payload],
  );

  return (
    <ModalContext.Provider value={value}>
      {children}
      {hostReady ? (
        <ModalHost type={state.type} payload={state.payload} onClose={closeModal} />
      ) : null}
    </ModalContext.Provider>
  );
}
