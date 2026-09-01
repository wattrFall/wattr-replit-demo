import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import App from "./App";
import "./index.css";

const publishableKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const proxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

createRoot(document.getElementById("root")!).render(
  <ClerkProvider
    publishableKey={publishableKey}
    proxyUrl={proxyUrl}
    signInUrl="/sign-in"
    signUpUrl="/sign-up"
    appearance={{
      theme: shadcn,
      options: {
        logoPlacement: "inside",
        logoLinkUrl: "/",
        logoImageUrl: `${window.location.origin}/logo.svg`,
      },
      variables: {
        colorPrimary: "#49c9d4",
        colorForeground: "#e8f0f8",
        colorMutedForeground: "#8191a4",
        colorBackground: "#101a26",
        colorInput: "#0c1620",
        colorInputForeground: "#e8f0f8",
        colorDanger: "#ff9589",
        colorNeutral: "#2a4054",
        fontFamily: "DM Sans, sans-serif",
        borderRadius: "7px",
      },
    }}
  >
    <App />
  </ClerkProvider>,
);
