import { createRoot } from "react-dom/client";
import "@fontsource-variable/space-grotesk";
import { Menu } from "./ui/Menu.tsx";
import { configureFolderProvider } from "./storage/folder-provider.ts";

async function bootstrap(): Promise<void> {
  const element = document.getElementById("root");
  if (!element) throw new Error("The application root is missing.");

  if (import.meta.env.DEV && import.meta.env.MODE === "local-folders") {
    try {
      const { createLocalFolderProvider } =
        await import("./storage/local-folders.ts");
      const token = document.querySelector<HTMLMetaElement>(
        'meta[name="ravefold-local-token"]',
      )?.content;
      const provider = createLocalFolderProvider(token ?? "");
      await provider.roots();
      configureFolderProvider(provider);
    } catch {
      element.textContent =
        "Local folders are unavailable. Check the development server.";
      return;
    }
  }

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
}

void bootstrap();
