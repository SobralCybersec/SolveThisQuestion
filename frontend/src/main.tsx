import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Overlay from "./Overlay";
import ChatOverlay from "./ChatOverlay";
import "./styles.css";

const isOverlay = new URLSearchParams(window.location.search).has("overlay");
const isChat = new URLSearchParams(window.location.search).has("chat");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isOverlay ? <Overlay /> : isChat ? <ChatOverlay /> : <App />}</StrictMode>,
);
