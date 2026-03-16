import { ChatBubble } from "../ChatBubble/ChatBubble";

import { RigobotProps } from "../../types";
import React, { useEffect, useState } from "react";
import { logger } from "../../utils/utilities";

const reportOpenAndClosed = (collapsed: boolean) => {
  if (window.rigo.callbacks["open_bubble"] && !collapsed) {
    window.rigo.callbacks["open_bubble"]({
      when: new Date().toISOString(),
      url: window.location.href,
    });
  }

  if (window.rigo.callbacks["close_bubble"] && collapsed) {
    window.rigo.callbacks["close_bubble"]({
      when: new Date().toISOString(),

      url: window.location.href,
    });
  }
};

export const Rigobot: React.FC<RigobotProps> = ({ chatAgentHash, options }) => {
  const [currentOptions, setCurrentOptions] = useState(options);

  const [originElement, setOriginElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (currentOptions.target) {
      const element = document.querySelector(currentOptions.target);
      // @ts-ignore
      setOriginElement(element);
      logger.debug("MOVING TO TARGET ELEMENT", element);
    } else {
      setOriginElement(null);
    }

    const handleOptionsUpdate = (event: any) => {
      console.log("REceiving update options event");

      const currentCollapsedState = currentOptions.collapsed;

      setCurrentOptions(event.detail);
      if (currentCollapsedState !== event.detail.collapsed) {
        reportOpenAndClosed(event.detail.collapsed);
      }
    };

    window.addEventListener("optionsUpdated", handleOptionsUpdate);
    window.addEventListener("messageSent", handleMessageSent);

    return () => {
      window.removeEventListener("optionsUpdated", handleOptionsUpdate);
      window.removeEventListener("messageSent", handleMessageSent);
    };
  }, [currentOptions]);

  const handleMessageSent = () => {
    setCurrentOptions({
      ...currentOptions,
      userMessage: undefined,
    });
  };

  const completeContext = `
  <page_context info="This context indicates information about the current website in which you are working on.">
  ${currentOptions.context}
  </page_context>
  <user_context info="This context indicates information about the user that is interacting with you if available.">
  ${currentOptions.user?.context || ""}
  </user_context>
  `;

  const toggleCollapsed = () => {
    const newCollapsedState = !currentOptions.collapsed;
    setCurrentOptions({
      ...currentOptions,
      collapsed: newCollapsedState,
    });
    window.rigo.options = {
      ...window.rigo.options,
      collapsed: newCollapsedState,
    };

    reportOpenAndClosed(newCollapsedState);
  };

  return (
    <ChatBubble
      user={{
        context: completeContext,
        token: currentOptions.user?.token || "",
        avatar: currentOptions.user?.avatar || "",
        nickname: currentOptions.user?.nickname || "User",
      }}
      socketHost={currentOptions.socketHost || import.meta.env.VITE_SOCKET_HOST}
      welcomeMessage={
        currentOptions.welcomeMessage || "Hi! How can I help you! 👋"
      }
      host={import.meta.env.VITE_RIGOBOT_HOST}
      purposeId={
        currentOptions.purposeId ? currentOptions.purposeId : undefined
      }
      purposeSlug={
        currentOptions.purposeSlug
          ? currentOptions.purposeSlug
          : "4geeks-academy-salesman"
      }
      chatAgentHash={chatAgentHash}
      collapsed={
        typeof currentOptions?.collapsed === "boolean"
          ? currentOptions?.collapsed
          : false
      }
      originElement={originElement}
      introVideo={currentOptions.introVideo}
      completions={currentOptions.completions}
      showBubble={currentOptions.showBubble}
      highlight={currentOptions.highlight}
      toggleCollapsed={toggleCollapsed}
      userMessage={currentOptions.userMessage}
    />
  );
};
