/** True only when the platform positively reports no connection; any doubt (or no platform) means false. */
export async function isOffline(): Promise<boolean> {
    try {
        const { Connectivity } = await import('@nativescript/core');
        return Connectivity.getConnectionType() === Connectivity.connectionType.none;
    } catch {
        return false;
    }
}
