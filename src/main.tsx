import { createRoot } from "react-dom/client";
import "@fontsource-variable/space-grotesk";
import { Menu } from "./ui/Menu.tsx";

const element = document.getElementById("root");
if (!element) throw new Error("The application root is missing.");

createRoot(element).render(
  <Menu
    onEntry={(entry) => {
      // The tracker slice consumes this checked result through the Menu callback.
      window.dispatchEvent(
        new CustomEvent("ravefold:entry", { detail: entry }),
      );
    }}
  />,
);
