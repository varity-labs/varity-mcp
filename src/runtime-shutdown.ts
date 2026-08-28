export type RuntimeShutdown = () => Promise<void>;

export interface RuntimeShutdownCoordinator {
  setRuntimeShutdown(closeRuntime: RuntimeShutdown): void;
  shutdown(closeTransport: boolean): Promise<void>;
}

/**
 * Own one idempotent shutdown promise. Telemetry custody is independent of
 * transport cleanup: exporter shutdown always runs, and a transport failure is
 * still returned to the caller so the process cannot report a successful exit.
 */
export function createRuntimeShutdownCoordinator(
  stopTelemetry: RuntimeShutdown
): RuntimeShutdownCoordinator {
  let closeRuntime: RuntimeShutdown = async () => undefined;
  let shutdownPromise: Promise<void> | undefined;

  return {
    setRuntimeShutdown(close): void {
      closeRuntime = close;
    },
    shutdown(closeTransport): Promise<void> {
      if (!shutdownPromise) {
        // EOF can otherwise leave no active handle while async exporters flush.
        const custodyHandle = setInterval(() => undefined, 1_000);
        shutdownPromise = (async () => {
          let transportFailure: unknown;
          if (closeTransport) {
            try {
              await closeRuntime();
            } catch (error) {
              transportFailure = error;
            }
          }

          try {
            await stopTelemetry();
          } catch (telemetryFailure) {
            if (transportFailure) {
              throw new AggregateError(
                [transportFailure, telemetryFailure],
                "Runtime transport and telemetry shutdown both failed"
              );
            }
            throw telemetryFailure;
          }

          if (transportFailure) throw transportFailure;
        })().finally(() => clearInterval(custodyHandle));
      }
      return shutdownPromise;
    },
  };
}
