# VaxTrack System Explorer

The explorer runs at [http://127.0.0.1:5193/system-explorer.html](http://127.0.0.1:5193/system-explorer.html). It uses the `demo-vaxtrack-explorer` Firestore emulator on port 8293. The web app's normal Vite and Netlify builds use their existing entry points.

From `C:\VAXTRACK\vaxtrack-web`, start the emulator in one PowerShell window.

```powershell
npm.cmd run emulators:system-explorer
```

Run the explorer in another window. On a fresh checkout, install the web and Cloud Functions dependencies with `npm.cmd ci` and `npm.cmd ci --prefix functions` first.

```powershell
npm.cmd run dev:system-explorer
```

## Try a scenario

1. Select **10-stop dispatch**, click **Start lab**, and choose **Seed 10 stops** in **Distributor / Dispatcher**.
2. Choose **Plan for Rider A** for a single trip with ten stops, or **Balance fleet & plan** to compare Rider assignments. The **Routing** log shows the input matrix, stop sequence, timing and any arrival conflicts.
3. Choose **Load & dispatch Rider A** and switch to **Mobile Rider**. Send GPS ticks to move toward the stop. A tick advances the simulated clock by 30 seconds. **Auto GPS** runs ticks while that role is open.
4. Select **Take detour** and send seven regular GPS ticks to open a route-deviation alert. Select **Return to route** and send five regular ticks to resolve it. **Drop connection** queues the latest position and **Reconnect & sync** sends it to Firestore.
5. At the stop, use **Check delivery area** and **Complete with sample proof**. The live inventory counters reflect the server's settlement.
6. In **Admin**, inject a temperature spike or add stock. The **Stock shortage** scenario demonstrates backorders and replenishment. **Conflicting time windows** lets you see a proposed plan before deciding whether to save it.

The local HTTP bridge invokes VaxTrack's Node business handlers with synthetic user records. It uses real Firestore transactions and listeners in the emulator. The Auth, App Check, callable transport, and Storage upload boundaries are shown in the inspector. The browser uses a synthetic road matrix, GPS samples, cached position, and proof metadata. Multi-rider balancing, the weighted load center, and temperature alerts are simulator models. Each new run has its own fixture IDs.

With both processes running, `npm.cmd run test:system-explorer` exercises the local HTTP and Firestore pipeline.
