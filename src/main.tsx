import { createRoot } from "react-dom/client";
import "@fontsource-variable/space-grotesk";
import { Menu } from "./ui/Menu.tsx";

const element = document.getElementById("root");
if (!element) throw new Error("The application root is missing.");

createRoot(element).render(
  <Menu
    onEntry={(entry) => {
      // Host integrations receive the validated project entry.
      window.dispatchEvent(
        new CustomEvent("ravefold:entry", { detail: entry }),
      );
    }}
  />,
);
