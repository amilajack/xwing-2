if (!process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  console.error("Use pnpm install --frozen-lockfile to install dependencies.");
  process.exit(1);
}
