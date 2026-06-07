// Health / config check. GET -> shows whether secrets are wired (never reveals them).
module.exports = async (req, res) => {
  res.status(200).json({
    ok: true,
    service: "ownerrez-pusher",
    time: new Date().toISOString(),
    configured: {
      ownerrez_user: Boolean(process.env.OWNERREZ_API_USER),
      ownerrez_token: Boolean(process.env.OWNERREZ_API_TOKEN),
      push_secret_set: Boolean(process.env.PUSH_SECRET),
      allow_writes: process.env.PUSH_ALLOW_WRITES === "true",
    },
  });
};
