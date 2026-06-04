import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useAuthActions, useAuthToken } from '@convex-dev/auth/react';
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import {
  addBatteryReading,
  addBookmark,
  addHeartRateReading,
  addPacket,
  clearPackets,
  getAllBatteryReadings,
  getAllBookmarks,
  getAllHeartRateReadings,
  getAllPackets,
  getRecentPackets,
} from './db';
import type { BatteryReading, Bookmark, CharacteristicInfo, Direction, HeartRateReading, PacketRecord, SeenDevice, ServiceInfo } from './types';
import {
  analyzeWhoopBacklog,
  analyzeLocalSleep,
  bytesToHex,
  dataViewToBytes,
  decodeWhoopProprietaryFrames,
  decimalValues,
  describePacket,
  downloadText,
  hexToBytes,
  isKnownUuid,
  latestByTimestamp,
  normalizeUuid,
  OPTIONAL_SERVICES,
  packetToCsv,
  parseHeartRateMeasurement,
  tryDecodeUtf8,
  uuidLabel,
} from './utils';
import type { LocalSleepAnalysis, WhoopBacklogAnalysis } from './utils';
import type { WhoopProprietaryFrameDecode } from './utils';
import { isPipelineConfigured, syncCaptureToPipeline } from './pipelineSync';
import type { CaptureLabel, PipelineSyncResult } from './pipelineSync';
import { buildWhoopHealthReport, healthReportToMarkdown, normalizeBluefyCapture } from './healthReport';
import type { HealthReport } from './healthReport';
import { getRememberMePreference, setRememberMePreference } from './authStorage';

const HEART_RATE_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
const HEART_RATE_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';
const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL = '00002a19-0000-1000-8000-00805f9b34fb';
const WHOOP_PROPRIETARY_SERVICE = '61080001-8d6d-82b8-614a-1c8cb0f8dcc6';
const WHOOP_COMMAND_CHARACTERISTIC = '61080002-8d6d-82b8-614a-1c8cb0f8dcc6';
const AUTO_SYNC_DEBOUNCE_MS = 4_500;
const DATA_CONSENT_VERSION = 'whoop-public-beta-2026-06-04';
const SLEEP_ESTIMATE_REFERENCE = {
  date: 'Jun 3, 2026',
  dateLong: 'Wed, Jun 3, 2026',
  window: '1:15 AM - 7:27 AM',
  duration: '6h 12m asleep',
  durationMinutes: 372,
  note: 'Local estimate line for the BLE sleep pipeline.',
};

type AutoSyncStage = 'idle' | 'connecting' | 'subscribing' | 'capturing' | 'processing' | 'sending' | 'synced' | 'error';
type StepState = 'done' | 'active' | 'waiting' | 'error';

interface LiveSyncStep {
  label: string;
  value: string;
  state: StepState;
}

interface ViewerInfo {
  id: string;
  email?: string;
  name?: string;
}

interface ConsentStatus {
  accepted: boolean;
  version: string;
  acceptedAt?: string;
}

const viewerQuery = makeFunctionReference<'query', Record<string, never>, ViewerInfo | null>('captures:viewer');
const currentUserConsentQuery = makeFunctionReference<'query', { version: string }, ConsentStatus>('captures:currentUserConsent');
const acceptDataConsentMutation = makeFunctionReference<'mutation', { version: string }, ConsentStatus>('captures:acceptDataConsent');

export default function App() {
  return (
    <>
      <AuthLoading>
        <main className="auth-shell">
          <section className="auth-card">
            <p className="eyebrow">Account</p>
            <h1>Checking your session</h1>
            <p>Loading the signed-in WHOOP capture workspace.</p>
          </section>
        </main>
      </AuthLoading>
      <Unauthenticated>
        <SignInScreen />
      </Unauthenticated>
      <Authenticated>
        <CaptureApp />
      </Authenticated>
    </>
  );
}

function CaptureApp() {
  const authToken = useAuthToken();
  const { signOut } = useAuthActions();
  const viewer = useQuery(viewerQuery, {});
  const consentStatus = useQuery(currentUserConsentQuery, { version: DATA_CONSENT_VERSION });
  const acceptDataConsent = useMutation(acceptDataConsentMutation);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState<string | null>(null);
  const [seenDevices, setSeenDevices] = useState<SeenDevice[]>([]);
  const [scanActive, setScanActive] = useState(false);
  const [connectedDevice, setConnectedDevice] = useState<BluetoothDevice | null>(null);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [selected, setSelected] = useState<CharacteristicInfo | null>(null);
  const [packets, setPackets] = useState<PacketRecord[]>([]);
  const [storedPackets, setStoredPackets] = useState<PacketRecord[]>([]);
  const [packetCount, setPacketCount] = useState(0);
  const [heartRates, setHeartRates] = useState<HeartRateReading[]>([]);
  const [batteryReadings, setBatteryReadings] = useState<BatteryReading[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [writeMode, setWriteMode] = useState(false);
  const [writeHex, setWriteHex] = useState('');
  const [exportOutput, setExportOutput] = useState<{ filename: string; text: string; format: 'json' | 'csv' | 'md' } | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [captureStartedAt, setCaptureStartedAt] = useState<string | null>(null);
  const [customOptionalServices, setCustomOptionalServices] = useState('');
  const [captureLabel, setCaptureLabel] = useState<CaptureLabel>('custom');
  const [autoCaptureEnabled, setAutoCaptureEnabled] = useState(true);
  const [autoSyncStage, setAutoSyncStage] = useState<AutoSyncStage>('idle');
  const [autoSyncMessage, setAutoSyncMessage] = useState('Connect WHOOP to begin. Capture and sync will run automatically.');
  const [pipelineSyncing, setPipelineSyncing] = useState(false);
  const [pipelineStatus, setPipelineStatus] = useState<PipelineSyncResult | null>(null);
  const [importedHealthReport, setImportedHealthReport] = useState<HealthReport | null>(null);
  const [decoderStatus, setDecoderStatus] = useState<string | null>(null);
  const [alarmActive, setAlarmActive] = useState(false);
  const [alarmTime, setAlarmTime] = useState('07:00');
  const [alarmTargetIso, setAlarmTargetIso] = useState<string | null>(null);
  const [alarmMessage, setAlarmMessage] = useState('Connect WHOOP to set a band alarm.');
  const [now, setNow] = useState(Date.now());
  const [acceptingConsent, setAcceptingConsent] = useState(false);
  const scanRef = useRef<BluetoothLEScan | null>(null);
  const advertisementHandlerRef = useRef<((event: Event) => void) | null>(null);
  const subscribedKeysRef = useRef<Set<string>>(new Set());
  const autoSyncTimerRef = useRef<number | null>(null);
  const bandAlarmCommandCounterRef = useRef(0x70);
  const alarmTimeRef = useRef('07:00');
  const autoSyncInFlightRef = useRef(false);
  const autoCaptureActiveRef = useRef(false);
  const lastAutoSyncedPacketCountRef = useRef(0);
  const sessionId = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    const hasBluetooth = typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);
    setSupported(hasBluetooth);
    void refreshLocalHistory();
    const interval = window.setInterval(() => setNow(Date.now()), 1000);

    return () => {
      window.clearInterval(interval);
      clearAutoSyncTimer();
      stopScan();
    };
  }, []);

  const connected = Boolean(connectedDevice?.gatt?.connected);
  const flatCharacteristics = services.flatMap((service) => service.characteristics);
  const whoopCommandCharacteristic = flatCharacteristics.find(
    (item) => item.uuid === WHOOP_COMMAND_CHARACTERISTIC && (item.properties.write || item.properties.writeWithoutResponse),
  );
  const bandAlarmAvailable = connected && Boolean(whoopCommandCharacteristic);
  const latestBattery = latestByTimestamp(batteryReadings);
  const latestHeartRate = latestByTimestamp(heartRates);
  const notifyCount = flatCharacteristics.filter((item) => item.properties.notify || item.properties.indicate).length;
  const writableCount = flatCharacteristics.filter((item) => item.properties.write || item.properties.writeWithoutResponse).length;
  const proprietaryPackets = packets.filter((packet) => packet.serviceUuid === WHOOP_PROPRIETARY_SERVICE);
  const proprietaryRecent = proprietaryPackets.filter((packet) => Date.now() - new Date(packet.timestamp).getTime() < 15_000);
  const backlogAnalysis = useMemo(() => analyzeWhoopBacklog(storedPackets), [storedPackets]);
  const reportedSleepForSync = useMemo(() => emptyReportedSleepWindow(), []);
  const localSleepAnalysis = useMemo(() => analyzeLocalSleep(storedPackets, backlogAnalysis), [storedPackets, backlogAnalysis]);
  const proprietaryFrameDecodes = useMemo(() => decodeWhoopProprietaryFrames(storedPackets), [storedPackets]);
  const localHealthReport = useMemo(() => buildWhoopHealthReport(storedPackets, 'Local IndexedDB capture'), [storedPackets]);
  const pipelineConfigured = isPipelineConfigured();
  const consentAccepted = consentStatus?.accepted === true;
  const consentLoading = consentStatus === undefined;
  const signedInEmail = viewer?.email ?? viewer?.name ?? 'Signed in';
  const cloudSyncReady = Boolean(pipelineConfigured && authToken && consentAccepted);
  const heartRatePacketCount = packets.filter((packet) => packet.serviceUuid === HEART_RATE_SERVICE && packet.characteristicUuid === HEART_RATE_MEASUREMENT).length;
  const batteryPacketCount = packets.filter((packet) => packet.serviceUuid === BATTERY_SERVICE && packet.characteristicUuid === BATTERY_LEVEL).length;
  const burstDetected = proprietaryRecent.length >= 3;
  const lastPacket = packets[0];
  const secondsSincePacket = lastPacket ? Math.floor((now - new Date(lastPacket.timestamp).getTime()) / 1000) : null;
  const isLive = connected && secondsSincePacket !== null && secondsSincePacket <= 5;
  const liveState = !connected ? 'offline' : isLive ? 'live' : 'quiet';
  const liveLabel = !connected ? 'Disconnected' : isLive ? 'Live' : 'Connected, no recent packets';
  const liveDetail = lastPacket
    ? `Last packet ${secondsSincePacket ?? 0}s ago from ${uuidLabel(lastPacket.characteristicUuid)}`
    : 'No packets received yet';
  const liveSyncSteps = buildLiveSyncSteps({
    connected,
    packetCount,
    pipelineSyncing,
    pipelineStatus,
    autoSyncStage,
  });

  async function refreshLocalHistory(): Promise<void> {
    const [recentPackets, allPackets, storedHeartRates, storedBatteryReadings, storedBookmarks] = await Promise.all([
      getRecentPackets(100),
      getAllPackets(),
      getAllHeartRateReadings(),
      getAllBatteryReadings(),
      getAllBookmarks(),
    ]);
    setPackets(recentPackets);
    setStoredPackets(allPackets);
    setPacketCount(allPackets.length);
    setHeartRates(storedHeartRates);
    setBatteryReadings(storedBatteryReadings);
    setBookmarks(storedBookmarks);
  }

  async function acceptCloudSyncConsent(): Promise<void> {
    setAcceptingConsent(true);
    setError(null);
    try {
      await acceptDataConsent({ version: DATA_CONSENT_VERSION });
      setStatus('Cloud sync consent accepted');
      setAutoSyncMessage('Consent accepted. Connect WHOOP to capture and automatically sync.');
    } catch (consentError) {
      setError(errorMessage(consentError));
      setStatus('Cloud sync consent failed');
    } finally {
      setAcceptingConsent(false);
    }
  }

  async function startScan(): Promise<void> {
    setError(null);
    if (!consentAccepted) {
      setError('Accept the cloud sync disclosure before connecting a WHOOP on the public app.');
      return;
    }
    if (!navigator.bluetooth) {
      setError('Web Bluetooth is not available in this browser. Open this app in Bluefy or another Web Bluetooth browser.');
      return;
    }

    if (navigator.bluetooth.requestLEScan) {
      try {
        setStatus('Scanning advertisements');
        setScanActive(true);
        if (advertisementHandlerRef.current) {
          navigator.bluetooth.removeEventListener('advertisementreceived', advertisementHandlerRef.current);
        }
        const onAdvertisement = (event: Event) => {
          const advertisement = event as BluetoothAdvertisingEvent;
          upsertSeenDevice({
            id: advertisement.device.id,
            name: advertisement.name ?? advertisement.device.name ?? 'Unnamed device',
            rssi: advertisement.rssi,
            lastSeen: Date.now(),
            device: advertisement.device,
          });
        };
        advertisementHandlerRef.current = onAdvertisement;
        navigator.bluetooth.addEventListener('advertisementreceived', onAdvertisement);
        const scan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
        scanRef.current = scan;
        setStatus('Scanning nearby BLE advertisements');
      } catch (scanError) {
        setScanActive(false);
        setError(errorMessage(scanError));
      }
      return;
    }

    await pickDevice();
  }

  function stopScan(): void {
    scanRef.current?.stop();
    scanRef.current = null;
    if (navigator.bluetooth && advertisementHandlerRef.current) {
      navigator.bluetooth.removeEventListener('advertisementreceived', advertisementHandlerRef.current);
      advertisementHandlerRef.current = null;
    }
    setScanActive(false);
    setStatus('Scan stopped');
  }

  async function startScheduledBandAlarm(timeValue = alarmTimeRef.current): Promise<void> {
    if (!whoopCommandCharacteristic) {
      setAlarmActive(false);
      setAlarmMessage('WHOOP band command characteristic is not available. Reconnect and keep the proprietary service enabled.');
      return;
    }

    const target = getNextAlarmDate(timeValue);

    try {
      await sendWhoopBandAlarmAt(whoopCommandCharacteristic, target);
    } catch (alarmError) {
      setAlarmActive(false);
      setAlarmTargetIso(null);
      setAlarmMessage(`WHOOP band alarm write failed: ${errorMessage(alarmError)}`);
      return;
    }

    setAlarmActive(true);
    setAlarmTargetIso(target.toISOString());
    setAlarmMessage(`On. WHOOP band alarm set for ${formatAlarmTarget(target)}.`);
  }

  function stopBandAlarm(message = 'Off. This page will not re-arm the band alarm. WHOOP does not expose a reliable cancel/read-back command over BLE.'): void {
    setAlarmActive(false);
    setAlarmTargetIso(null);
    setAlarmMessage(message);
  }

  function toggleBandAlarm(): void {
    if (alarmActive) {
      stopBandAlarm();
      return;
    }
    void startScheduledBandAlarm();
  }

  function updateAlarmTime(value: string): void {
    alarmTimeRef.current = value;
    setAlarmTime(value);
    if (alarmActive) {
      void startScheduledBandAlarm(value);
    }
  }

  async function sendWhoopBandAlarmAt(commandCharacteristic: CharacteristicInfo, alarmTimeDate: Date): Promise<void> {
    const alarmUnixSeconds = Math.floor(alarmTimeDate.getTime() / 1000);
    const counter = bandAlarmCommandCounterRef.current & 0xff;
    bandAlarmCommandCounterRef.current = (counter + 1) & 0xff;
    const packet = buildWhoopAlarmPacket(alarmUnixSeconds, counter);
    const packetBuffer = packet.buffer as ArrayBuffer;
    const writable = commandCharacteristic.characteristic as BluetoothRemoteGATTCharacteristic & {
      writeValueWithResponse?: (value: BufferSource) => Promise<void>;
      writeValueWithoutResponse?: (value: BufferSource) => Promise<void>;
      writeValue?: (value: BufferSource) => Promise<void>;
    };

    if (commandCharacteristic.properties.write && writable.writeValueWithResponse) {
      await writable.writeValueWithResponse(packetBuffer);
    } else if (commandCharacteristic.properties.writeWithoutResponse && writable.writeValueWithoutResponse) {
      await writable.writeValueWithoutResponse(packetBuffer);
    } else if (writable.writeValue) {
      await writable.writeValue(packetBuffer);
    } else {
      throw new Error('This browser does not expose a compatible WHOOP write method.');
    }

    await logPacket(commandCharacteristic, 'write', new DataView(packetBuffer));
    setStatus(`Set WHOOP band alarm for ${new Date(alarmUnixSeconds * 1000).toLocaleTimeString()}`);
  }

  async function pickDevice(): Promise<void> {
    setError(null);
    if (!consentAccepted) {
      setError('Accept the cloud sync disclosure before connecting a WHOOP on the public app.');
      return;
    }
    if (!navigator.bluetooth) {
      setError('Web Bluetooth is not available in this browser.');
      return;
    }

    try {
      setStatus('Opening Bluetooth device picker');
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: buildOptionalServices(),
      });
      const seenDevice = {
        id: device.id,
        name: device.name ?? 'Unnamed device',
        lastSeen: Date.now(),
        device,
      };
      upsertSeenDevice(seenDevice);
      await connectToDevice(seenDevice);
    } catch (pickError) {
      setError(errorMessage(pickError));
      setStatus('Ready');
    }
  }

  async function connectToDevice(seenDevice: SeenDevice): Promise<void> {
    if (!consentAccepted) {
      setError('Accept the cloud sync disclosure before connecting a WHOOP on the public app.');
      return;
    }
    if (!seenDevice.device) {
      setError('This browser did not provide a connectable device object for the scan result. Use Pick Device to connect.');
      return;
    }

    setError(null);
    setStatus(`Connecting to ${seenDevice.name}`);
    setAutoSyncStage('connecting');
    setAutoSyncMessage(`Connecting to ${seenDevice.name}.`);
    stopScan();

    try {
      const device = seenDevice.device;
      device.addEventListener('gattserverdisconnected', () => {
        setStatus('Disconnected');
        setConnectedDevice(null);
        setAutoSyncStage('idle');
        setAutoSyncMessage('WHOOP disconnected. Connect again to capture and sync.');
        stopBandAlarm('WHOOP disconnected. Alarm disabled in this page.');
        autoCaptureActiveRef.current = false;
        subscribedKeysRef.current.clear();
      });

      const server = await device.gatt?.connect();
      if (!server) {
        throw new Error('Unable to open a GATT connection.');
      }

      setConnectedDevice(device);
      setStatus('Enumerating GATT services');
      const discovered = await enumerateServices(server);
      setServices(discovered);
      setSelected(discovered[0]?.characteristics[0] ?? null);
      setStatus(`Connected to ${device.name ?? device.id}`);
      await readStandardValues(discovered);
      if (autoCaptureEnabled) {
        await startDataCapture(discovered, true);
      } else {
        setAutoSyncStage('idle');
        setAutoSyncMessage('Connected. Automatic capture is turned off.');
      }
    } catch (connectError) {
      setError(errorMessage(connectError));
      setStatus('Connection failed');
      setAutoSyncStage('error');
      setAutoSyncMessage(errorMessage(connectError));
    }
  }

  async function enumerateServices(server: BluetoothRemoteGATTServer): Promise<ServiceInfo[]> {
    const primaryServices = await server.getPrimaryServices();
    const result: ServiceInfo[] = [];

    for (const service of primaryServices) {
      try {
        const characteristics = await service.getCharacteristics();
        result.push({
          uuid: normalizeUuid(service.uuid),
          service,
          characteristics: characteristics.map((characteristic) => toCharacteristicInfo(service.uuid, characteristic)),
        });
      } catch (serviceError) {
        setError(`Could not enumerate ${service.uuid}: ${errorMessage(serviceError)}`);
        result.push({ uuid: normalizeUuid(service.uuid), service, characteristics: [] });
      }
    }

    return result.sort((a, b) => a.uuid.localeCompare(b.uuid));
  }

  function toCharacteristicInfo(serviceUuid: string, characteristic: BluetoothRemoteGATTCharacteristic): CharacteristicInfo {
    return {
      uuid: normalizeUuid(characteristic.uuid),
      serviceUuid: normalizeUuid(serviceUuid),
      characteristic,
      properties: {
        read: characteristic.properties.read,
        write: characteristic.properties.write,
        writeWithoutResponse: characteristic.properties.writeWithoutResponse,
        notify: characteristic.properties.notify,
        indicate: characteristic.properties.indicate,
      },
    };
  }

  async function readStandardValues(discovered: ServiceInfo[]): Promise<void> {
    for (const characteristic of discovered.flatMap((service) => service.characteristics)) {
      if (characteristic.properties.read && [BATTERY_LEVEL, HEART_RATE_MEASUREMENT].includes(characteristic.uuid)) {
        await readCharacteristic(characteristic);
      }
    }
  }

  async function readCharacteristic(characteristic: CharacteristicInfo): Promise<void> {
    setError(null);
    if (!characteristic.properties.read) {
      setError('This characteristic is not readable.');
      return;
    }

    try {
      const value = await characteristic.characteristic.readValue();
      setCharacteristicValue(characteristic, value);
      await logPacket(characteristic, 'read', value);
      detectStandardData(characteristic, value);
      setStatus(`Read ${characteristic.uuid}`);
    } catch (readError) {
      setError(errorMessage(readError));
    }
  }

  async function subscribeAllNotifications(characteristics = flatCharacteristics): Promise<number> {
    setError(null);
    const candidates = characteristics.filter((item) => item.properties.notify || item.properties.indicate);
    if (candidates.length === 0) {
      setStatus('No notify or indicate characteristics exposed');
      return 0;
    }

    let count = 0;
    for (const characteristic of candidates) {
      const key = `${characteristic.serviceUuid}:${characteristic.uuid}`;
      if (subscribedKeysRef.current.has(key)) {
        continue;
      }

      try {
        await characteristic.characteristic.startNotifications();
        characteristic.characteristic.addEventListener('characteristicvaluechanged', (event) => {
          const source = event.target as BluetoothRemoteGATTCharacteristic;
          if (!source.value) {
            return;
          }
          const direction: Direction = characteristic.properties.indicate && !characteristic.properties.notify ? 'indicate' : 'notify';
          setCharacteristicValue(characteristic, source.value);
          void logPacket(characteristic, direction, source.value);
          detectStandardData(characteristic, source.value);
        });
        subscribedKeysRef.current.add(key);
        markSubscribed(characteristic, true);
        count += 1;
      } catch (subscribeError) {
        setError(`Subscribe failed for ${characteristic.uuid}: ${errorMessage(subscribeError)}`);
      }
    }

    setStatus(`Subscribed to ${count} notification source${count === 1 ? '' : 's'}`);
    return count;
  }

  async function startMorningCapture(): Promise<void> {
    await startDataCapture(undefined, false);
  }

  async function startDataCapture(discovered?: ServiceInfo[], automatic = false): Promise<void> {
    if (!connected && !discovered) {
      setError('Connect to your WHOOP first, then start morning capture.');
      return;
    }
    const characteristics = discovered?.flatMap((service) => service.characteristics) ?? flatCharacteristics;
    autoCaptureActiveRef.current = true;
    lastAutoSyncedPacketCountRef.current = 0;
    setCaptureStartedAt((existing) => existing ?? new Date().toISOString());
    setAutoSyncStage('subscribing');
    setAutoSyncMessage('Bluetooth connected. Subscribing to live WHOOP notifications.');
    const count = await subscribeAllNotifications(characteristics);
    setAutoSyncStage('capturing');
    setAutoSyncMessage(
      count > 0
        ? automatic
          ? 'Capture started automatically. Waiting for packets before sending.'
          : 'Capture is running. Waiting for packets before sending.'
        : 'Connected, but no notify sources were exposed. Any readable data will still be stored locally.',
    );
    setStatus('Capture is listening for WHOOP packets');
    void queueExistingCaptureSync();
  }

  async function sendWrite(): Promise<void> {
    setError(null);
    if (!selected) {
      setError('Select a writable characteristic first.');
      return;
    }
    if (!writeMode) {
      setError('Write testing mode is disabled.');
      return;
    }
    if (!selected.properties.write && !selected.properties.writeWithoutResponse) {
      setError('Selected characteristic is not writable.');
      return;
    }

    let bytes: number[];
    try {
      bytes = hexToBytes(writeHex);
    } catch (hexError) {
      setError(errorMessage(hexError));
      return;
    }
    if (bytes.length === 0) {
      setError('Enter at least one byte.');
      return;
    }
    const confirmed = window.confirm(`Write ${bytesToHex(bytes)} to ${selected.uuid}? This can change device state.`);
    if (!confirmed) {
      return;
    }

    try {
      const payload = new Uint8Array(bytes);
      const writable = selected.characteristic as BluetoothRemoteGATTCharacteristic & {
        writeValueWithResponse?: (value: BufferSource) => Promise<void>;
        writeValueWithoutResponse?: (value: BufferSource) => Promise<void>;
        writeValue?: (value: BufferSource) => Promise<void>;
      };

      if (selected.properties.write && writable.writeValueWithResponse) {
        await writable.writeValueWithResponse(payload);
      } else if (selected.properties.writeWithoutResponse && writable.writeValueWithoutResponse) {
        await writable.writeValueWithoutResponse(payload);
      } else if (writable.writeValue) {
        await writable.writeValue(payload);
      } else {
        throw new Error('This browser does not expose a compatible write method.');
      }

      await logPacket(selected, 'write', new DataView(payload.buffer));
      setStatus(`Wrote ${bytes.length} byte${bytes.length === 1 ? '' : 's'}`);
    } catch (writeError) {
      setError(errorMessage(writeError));
    }
  }

  async function logPacket(characteristic: CharacteristicInfo, direction: Direction, value: DataView): Promise<void> {
    const bytes = dataViewToBytes(value);
    const record: PacketRecord = {
      sessionId,
      deviceId: connectedDevice?.id ?? 'unknown',
      deviceName: connectedDevice?.name ?? 'Unknown device',
      serviceUuid: characteristic.serviceUuid,
      characteristicUuid: characteristic.uuid,
      direction,
      rawHex: bytesToHex(bytes),
      bytes,
      timestamp: new Date().toISOString(),
    };
    setPackets((current) => [record, ...current].slice(0, 100));
    setStoredPackets((current) => [...current, record]);
    setPacketCount((count) => count + 1);
    await addPacket(record);
    queueAutoSync(record);
  }

  function detectStandardData(characteristic: CharacteristicInfo, value: DataView): void {
    if (characteristic.serviceUuid === HEART_RATE_SERVICE && characteristic.uuid === HEART_RATE_MEASUREMENT) {
      const parsed = parseHeartRateMeasurement(value);
      if (parsed) {
        const reading: HeartRateReading = {
          ...parsed,
          sessionId,
          deviceId: connectedDevice?.id ?? 'unknown',
          timestamp: new Date().toISOString(),
        };
        setHeartRates((current) => [...current, reading].slice(-240));
        void addHeartRateReading(reading);
      }
    }

    if (characteristic.serviceUuid === BATTERY_SERVICE && characteristic.uuid === BATTERY_LEVEL && value.byteLength > 0) {
      const reading: BatteryReading = {
        sessionId,
        deviceId: connectedDevice?.id ?? 'unknown',
        percentage: value.getUint8(0),
        timestamp: new Date().toISOString(),
      };
      setBatteryReadings((current) => [...current, reading].slice(-240));
      void addBatteryReading(reading);
    }
  }

  async function bookmarkCharacteristic(characteristic: CharacteristicInfo): Promise<void> {
    const bookmark: Bookmark = {
      deviceId: connectedDevice?.id ?? 'unknown',
      serviceUuid: characteristic.serviceUuid,
      characteristicUuid: characteristic.uuid,
      label: `${uuidLabel(characteristic.serviceUuid)} / ${uuidLabel(characteristic.uuid)}`,
      timestamp: new Date().toISOString(),
    };
    await addBookmark(bookmark);
    setBookmarks((current) => [bookmark, ...current]);
  }

  async function exportJson(): Promise<void> {
    const allPackets = await getAllPackets();
    const filename = `ble-packets-${new Date().toISOString()}.json`;
    const text = JSON.stringify(allPackets, null, 2);
    setExportOutput({ filename, text, format: 'json' });
    setCopyStatus(null);
    downloadText(filename, text, 'application/json');
    setStatus(`Prepared JSON export with ${allPackets.length} packet${allPackets.length === 1 ? '' : 's'}`);
  }

  async function copyJsonExport(): Promise<void> {
    const allPackets = await getAllPackets();
    const filename = `whoop-morning-capture-${new Date().toISOString()}.json`;
    const text = JSON.stringify(allPackets, null, 2);
    setExportOutput({ filename, text, format: 'json' });
    setCopyStatus(null);

    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(`Copied ${allPackets.length} packets to clipboard.`);
      setStatus('JSON data copied');
    } catch {
      setCopyStatus('Copy is blocked here. Use the export box below: tap inside, select all, then copy.');
      setStatus('JSON data is ready in the export box');
    }
  }

  async function shareJsonExport(): Promise<void> {
    const allPackets = await getAllPackets();
    const filename = `whoop-morning-capture-${new Date().toISOString()}.json`;
    const text = JSON.stringify(allPackets, null, 2);
    setExportOutput({ filename, text, format: 'json' });
    setCopyStatus(null);

    const file = new File([text], filename, { type: 'application/json' });
    const shareData = {
      title: 'WHOOP BLE capture',
      text: `WHOOP BLE capture with ${allPackets.length} packets.`,
      files: [file],
    };

    try {
      const nav = navigator as Navigator & {
        canShare?: (data: { files?: File[] }) => boolean;
        share?: (data: ShareData & { files?: File[] }) => Promise<void>;
      };
      if (!nav.share || (nav.canShare && !nav.canShare({ files: [file] }))) {
        throw new Error('Native share is not available for this browser.');
      }
      await nav.share(shareData);
      setStatus('Share sheet opened');
    } catch {
      setCopyStatus('Share is not available here. Use Copy Data or copy from the export box.');
      setStatus('JSON data is ready in the export box');
    }
  }

  function clearAutoSyncTimer(): void {
    if (autoSyncTimerRef.current !== null) {
      window.clearTimeout(autoSyncTimerRef.current);
      autoSyncTimerRef.current = null;
    }
  }

  function queueAutoSync(record: PacketRecord): void {
    if (!autoCaptureEnabled || !autoCaptureActiveRef.current || record.sessionId !== sessionId) {
      return;
    }

    if (!consentAccepted) {
      setAutoSyncStage('capturing');
      setAutoSyncMessage('Packet captured locally. Accept the cloud sync disclosure before upload.');
      return;
    }

    if (!authToken) {
      setAutoSyncStage('capturing');
      setAutoSyncMessage('Packet captured locally. Signed-in session is still loading.');
      return;
    }

    if (!pipelineConfigured) {
      setAutoSyncStage('capturing');
      setAutoSyncMessage('Packet captured locally. Cloud sync is not configured.');
      return;
    }

    if (autoSyncTimerRef.current !== null || autoSyncInFlightRef.current) {
      return;
    }

    scheduleAutoSyncUpload();
  }

  async function queueExistingCaptureSync(): Promise<void> {
    if (!autoCaptureEnabled || !autoCaptureActiveRef.current || autoSyncTimerRef.current !== null || autoSyncInFlightRef.current) {
      return;
    }
    const allPackets = await getAllPackets();
    const sessionPackets = allPackets.filter((packet) => packet.sessionId === sessionId);
    if (sessionPackets.length === 0 || sessionPackets.length <= lastAutoSyncedPacketCountRef.current) {
      return;
    }
    if (!consentAccepted) {
      setAutoSyncStage('capturing');
      setAutoSyncMessage('Data captured locally. Accept the cloud sync disclosure before upload.');
      return;
    }
    if (!authToken) {
      setAutoSyncStage('capturing');
      setAutoSyncMessage('Data captured locally. Signed-in session is still loading.');
      return;
    }
    if (!pipelineConfigured) {
      setAutoSyncStage('capturing');
      setAutoSyncMessage('Data captured locally. Cloud sync is not configured.');
      return;
    }
    scheduleAutoSyncUpload();
  }

  function scheduleAutoSyncUpload(): void {
    setAutoSyncStage('processing');
    setAutoSyncMessage('Data received. Processing local scores and preparing upload.');
    autoSyncTimerRef.current = window.setTimeout(() => {
      autoSyncTimerRef.current = null;
      autoSyncInFlightRef.current = true;
      setAutoSyncStage('sending');
      setAutoSyncMessage('Sending packets and decoded health data to your pipeline.');
      void syncToHealthPipeline({ automatic: true }).then((result) => {
        if (result?.ok) {
          setAutoSyncStage('synced');
          setAutoSyncMessage(result.message);
        } else {
          setAutoSyncStage('error');
          setAutoSyncMessage(result?.message ?? 'Health pipeline sync did not complete.');
        }
      }).finally(() => {
        autoSyncInFlightRef.current = false;
        if (autoCaptureActiveRef.current) {
          void queueExistingCaptureSync();
        }
      });
    }, AUTO_SYNC_DEBOUNCE_MS);
  }

  async function syncToHealthPipeline(options: { automatic?: boolean } = {}): Promise<PipelineSyncResult> {
    setPipelineSyncing(true);
    setPipelineStatus(null);
    setError(null);

    try {
      if (!consentAccepted) {
        const result: PipelineSyncResult = {
          ok: false,
          status: 'failed',
          message: 'Accept the cloud sync disclosure before uploading WHOOP captures.',
        };
        setPipelineStatus(result);
        setStatus('Cloud sync consent required');
        return result;
      }

      if (!authToken) {
        const result: PipelineSyncResult = {
          ok: false,
          status: 'failed',
          message: 'Sign in before syncing WHOOP captures to the health pipeline.',
        };
        setPipelineStatus(result);
        setStatus('Signed-in session is not ready');
        return result;
      }

      const [allPackets, allHeartRates, allBatteryReadings] = await Promise.all([
        getAllPackets(),
        getAllHeartRateReadings(),
        getAllBatteryReadings(),
      ]);
      const packetsToSync = options.automatic
        ? allPackets.filter((packet) => packet.sessionId === sessionId)
        : allPackets;
      const heartRatesToSync = options.automatic
        ? allHeartRates.filter((reading) => reading.sessionId === sessionId)
        : allHeartRates;
      const batteryReadingsToSync = options.automatic
        ? allBatteryReadings.filter((reading) => reading.sessionId === sessionId)
        : allBatteryReadings;

      if (options.automatic && packetsToSync.length <= lastAutoSyncedPacketCountRef.current) {
        const result: PipelineSyncResult = {
          ok: true,
          status: 'synced',
          message: 'Health pipeline is current. Waiting for new packets.',
          packetCount: packetsToSync.length,
          decodedCount: heartRatesToSync.length + batteryReadingsToSync.length,
        };
        setPipelineStatus(result);
        return result;
      }

      const result = await syncCaptureToPipeline({
        label: captureLabel,
        sessionId,
        deviceId: connectedDevice?.id ?? packetsToSync[packetsToSync.length - 1]?.deviceId ?? 'unknown',
        deviceName: connectedDevice?.name ?? packetsToSync[packetsToSync.length - 1]?.deviceName ?? 'Unknown device',
        captureStartedAt,
        packets: packetsToSync,
        heartRates: heartRatesToSync,
        batteryReadings: batteryReadingsToSync,
        backlog: analyzeWhoopBacklog(packetsToSync),
        localSleep: analyzeLocalSleep(packetsToSync, analyzeWhoopBacklog(packetsToSync)),
        reportedSleep: reportedSleepForSync,
      }, authToken);
      setPipelineStatus(result);
      setStatus(result.ok ? 'Health pipeline sync complete' : 'Health pipeline sync not complete');
      if (result.ok) {
        lastAutoSyncedPacketCountRef.current = packetsToSync.length;
      }
      return result;
    } catch (syncError) {
      const result: PipelineSyncResult = {
        ok: false,
        status: 'failed',
        message: errorMessage(syncError),
      };
      setPipelineStatus(result);
      setStatus(options.automatic ? 'Automatic health pipeline sync failed' : 'Health pipeline sync failed');
      setError(errorMessage(syncError));
      return result;
    } finally {
      setPipelineSyncing(false);
    }
  }

  async function importBluefyCapture(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    setDecoderStatus(`Reading ${file.name}`);
    setError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const importedPackets = normalizeBluefyCapture(parsed, file.name);
      if (importedPackets.length === 0) {
        throw new Error('No packet records were found in that JSON file.');
      }
      const report = buildWhoopHealthReport(importedPackets, file.name);
      setImportedHealthReport(report);
      setDecoderStatus(`Decoded ${importedPackets.length} packets from ${file.name}.`);
    } catch (importError) {
      setDecoderStatus(null);
      setError(errorMessage(importError));
    }
  }

  function showHealthReport(report: HealthReport): void {
    const filename = `whoop-local-health-report-${new Date().toISOString()}.md`;
    setExportOutput({ filename, text: healthReportToMarkdown(report), format: 'md' });
    setCopyStatus(null);
    setStatus('Health report is ready in the export box');
  }

  async function exportCsv(): Promise<void> {
    const allPackets = await getAllPackets();
    const filename = `ble-packets-${new Date().toISOString()}.csv`;
    const text = packetToCsv(allPackets);
    setExportOutput({ filename, text, format: 'csv' });
    setCopyStatus(null);
    downloadText(filename, text, 'text/csv');
    setStatus(`Prepared CSV export with ${allPackets.length} packet${allPackets.length === 1 ? '' : 's'}`);
  }

  async function copyExportOutput(): Promise<void> {
    if (!exportOutput) {
      return;
    }

    try {
      await navigator.clipboard.writeText(exportOutput.text);
      setCopyStatus('Copied export to clipboard.');
    } catch {
      setCopyStatus('Clipboard copy is blocked here. Tap inside the export box, select all, then copy.');
    }
  }

  async function clearPacketHistory(): Promise<void> {
    const confirmed = window.confirm('Clear locally stored packet records? Heart-rate, battery, and bookmark history will remain.');
    if (!confirmed) {
      return;
    }
    await clearPackets();
    setPackets([]);
    setStoredPackets([]);
    setPacketCount(0);
  }

  function setCharacteristicValue(characteristic: CharacteristicInfo, value: DataView): void {
    setServices((current) =>
      current.map((service) => ({
        ...service,
        characteristics: service.characteristics.map((item) =>
          item.serviceUuid === characteristic.serviceUuid && item.uuid === characteristic.uuid ? { ...item, value } : item,
        ),
      })),
    );
    setSelected((current) => {
      if (current?.serviceUuid === characteristic.serviceUuid && current.uuid === characteristic.uuid) {
        return { ...current, value };
      }
      return current;
    });
  }

  function markSubscribed(characteristic: CharacteristicInfo, subscribed: boolean): void {
    setServices((current) =>
      current.map((service) => ({
        ...service,
        characteristics: service.characteristics.map((item) =>
          item.serviceUuid === characteristic.serviceUuid && item.uuid === characteristic.uuid ? { ...item, subscribed } : item,
        ),
      })),
    );
  }

  function upsertSeenDevice(device: SeenDevice): void {
    setSeenDevices((current) => {
      const without = current.filter((item) => item.id !== device.id);
      return [device, ...without].sort((a, b) => b.lastSeen - a.lastSeen);
    });
  }

  function buildOptionalServices(): BluetoothServiceUUID[] {
    const custom = customOptionalServices
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    return [...OPTIONAL_SERVICES, ...custom];
  }

  const selectedBytes = selected?.value ? dataViewToBytes(selected.value) : [];
  const selectedUtf8 = tryDecodeUtf8(selectedBytes);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local BLE Health Lab</p>
          <h1>WHOOP Health Capture</h1>
        </div>
        <div className="topbar-actions">
          <span className="signed-in-label">{signedInEmail}</span>
          <button type="button" className="secondary-action" onClick={() => void signOut()}>Sign out</button>
          <div className={`connection-pill ${connected ? 'is-connected' : ''}`}>{connected ? 'Connected' : 'Disconnected'}</div>
        </div>
      </header>

      <section className="notice">
        <strong>Signed-in sync.</strong> This page talks directly to your WHOOP over Bluetooth, saves packets on this device, and automatically sends connected-session data to Convex after you accept the cloud sync disclosure.
      </section>

      <CloudSyncConsentPanel
        accepted={consentAccepted}
        loading={consentLoading}
        accepting={acceptingConsent}
        acceptedAt={consentStatus?.acceptedAt}
        onAccept={acceptCloudSyncConsent}
      />

      {supported === false && (
        <section className="error-panel">
          Web Bluetooth is unavailable here. Open this page in Bluefy on iPhone or a browser with Web Bluetooth support.
        </section>
      )}

      {error && <section className="error-panel">{error}</section>}

      <section className="workflow-panel">
        <div className="workflow-copy">
          <p className="eyebrow">Live Sync</p>
          <h2>Connect once. We handle the rest.</h2>
          <p>
            After Bluetooth connects, the page automatically starts capture, processes incoming packets, and sends the data to your health pipeline.
          </p>
        </div>

        <div className={`live-status ${liveState}`} role="status" aria-live="polite">
          <div>
            <span>Status</span>
            <strong>{liveLabel}</strong>
          </div>
          <p>{liveDetail}</p>
        </div>

        <div className="workflow-actions">
          <button className="primary-action" onClick={pickDevice} disabled={!supported || autoSyncStage === 'connecting' || !consentAccepted}>Connect WHOOP</button>
        </div>

        <LiveSyncTimeline steps={liveSyncSteps} message={autoSyncMessage} />

        <div className={`pipeline-state ${pipelineStatus?.ok ? 'good' : cloudSyncReady ? 'neutral' : 'warn'}`}>
          <strong>{pipelineStatus?.ok ? 'Sent to health pipeline' : cloudSyncReady ? 'Ready to send' : consentAccepted ? 'Sync waiting' : 'Disclosure required'}</strong>
          <span>
            {pipelineStatus?.message ??
              (cloudSyncReady
                ? 'While connected, new packets are batched to Convex with decoded heart rate, RR, battery, and sleep analysis.'
                : consentAccepted
                  ? 'Cloud sync needs a signed-in session and configured Convex deployment before upload can run.'
                  : 'Accept the cloud sync disclosure to enable automatic upload after connect.')}
          </span>
        </div>

        <details className="simple-options">
          <summary>Options</summary>
          <div className="pipeline-control">
            <label>
              <span className="toggle-line">
                <input type="checkbox" checked={autoCaptureEnabled} onChange={(event) => setAutoCaptureEnabled(event.target.checked)} />
                Auto capture and send after connect
              </span>
            </label>
            <label>
              Optional capture label
              <select value={captureLabel} onChange={(event) => setCaptureLabel(event.target.value as CaptureLabel)}>
                <option value="custom">Unlabeled</option>
                <option value="morning_reconnect">Morning reconnect</option>
                <option value="awake">Awake</option>
                <option value="sleep">Sleep</option>
                <option value="exercise">Exercise</option>
                <option value="charging">Charging</option>
              </select>
            </label>
          </div>
        </details>

        <div className="simple-summary-row">
          <Signal label="Connection" value={liveLabel} subValue={connectedDevice?.name ?? 'No device'} tone={isLive ? 'good' : connected ? 'neutral' : 'warn'} />
          <Signal label="Heart Rate" value={latestHeartRate ? `${latestHeartRate.bpm} bpm` : 'No reading'} />
          <Signal label="Captured" value={String(packetCount)} subValue="local packets" tone={packetCount > 0 ? 'good' : 'neutral'} />
        </div>

        <div className="backup-actions">
          <button onClick={copyJsonExport} disabled={packetCount === 0}>Copy Backup</button>
          <button onClick={shareJsonExport} disabled={packetCount === 0}>Share Backup</button>
        </div>

        {captureStartedAt && <p className="capture-start">Capture started {new Date(captureStartedAt).toLocaleTimeString()}.</p>}
        <ExportOutputPanel exportOutput={exportOutput} copyStatus={copyStatus} onCopy={copyExportOutput} onClose={() => setExportOutput(null)} />
      </section>

      <TodayFeedPanel
        report={localHealthReport}
        latestHeartRate={latestHeartRate}
        latestBattery={latestBattery}
        packetCount={packetCount}
        pipelineStatus={pipelineStatus}
        currentDate={new Date(now)}
        alarmActive={alarmActive}
        alarmAvailable={bandAlarmAvailable}
        alarmMessage={
          bandAlarmAvailable
            ? alarmMessage.startsWith('Connect WHOOP')
              ? 'Ready. Pick a time and turn on the WHOOP band alarm.'
              : alarmMessage
            : connected
              ? 'WHOOP command characteristic not exposed. Reconnect the band and keep proprietary service access enabled.'
              : 'Connect WHOOP to set a band alarm.'
        }
        alarmTime={alarmTime}
        alarmTargetIso={alarmTargetIso}
        onAlarmTimeChange={updateAlarmTime}
        onToggleAlarm={toggleBandAlarm}
      />

      <details className="developer-tools">
        <summary>
          <span>Developer Tools</span>
          <strong>decoders, raw packets, BLE explorer</strong>
        </summary>

      <details className="review-panel">
        <summary>Review capture</summary>
        <HealthDecoderPipelinePanel
          localReport={localHealthReport}
          importedReport={importedHealthReport}
          decoderStatus={decoderStatus}
          onImport={importBluefyCapture}
          onShowReport={showHealthReport}
        />
      </details>

      <details className="review-panel">
        <summary>Sleep estimate</summary>
        <LocalSleepAnalysisPanel
          analysis={localSleepAnalysis}
        />
      </details>

      <details className="review-panel">
        <summary>Backlog decoder</summary>
        <MorningScanSummary packets={storedPackets} backlog={backlogAnalysis} />
        <BacklogDecoder analysis={backlogAnalysis} totalPackets={storedPackets.length} />
        <ProprietaryDecodeLab frames={proprietaryFrameDecodes} />
      </details>

      <details className="advanced-panel">
        <summary>Raw Capture Tools</summary>
      <section className="dashboard-grid">
        <Metric label="Status" value={status} />
        <Metric label="Device" value={connectedDevice?.name ?? 'None'} subValue={connectedDevice?.id} />
        <Metric label="Heart Rate" value={latestHeartRate ? `${latestHeartRate.bpm} bpm` : 'No reading'} />
        <Metric label="Battery" value={latestBattery ? `${latestBattery.percentage}%` : 'No reading'} />
        <Metric label="Notifications" value={`${notifyCount} sources`} subValue={`${packets.filter((packet) => packet.direction === 'notify' || packet.direction === 'indicate').length} recent packets`} />
        <Metric label="Packets" value={String(packetCount)} subValue="Stored locally" />
      </section>

      <div className="content-grid">
        <section className="panel scanner-panel">
          <div className="section-heading">
            <div>
              <h2>Device Scanner</h2>
              <p>{scanActive ? 'Listening for BLE advertisements.' : 'Use the picker if passive scanning is not exposed.'}</p>
            </div>
            <div className="button-row">
              <button onClick={startScan} disabled={!supported || scanActive || !consentAccepted}>Scan</button>
              <button onClick={stopScan} disabled={!scanActive}>Stop</button>
              <button onClick={pickDevice} disabled={!supported || !consentAccepted}>Pick Device</button>
            </div>
          </div>

          <label className="field-label" htmlFor="optional-services">Extra optional service UUIDs</label>
          <textarea
            id="optional-services"
            value={customOptionalServices}
            onChange={(event) => setCustomOptionalServices(event.target.value)}
            placeholder="Comma or space separated UUIDs to request during device selection"
          />

          <div className="device-list">
            {seenDevices.length === 0 ? (
              <EmptyState text="No devices captured yet." />
            ) : (
              seenDevices.map((device) => (
                <article className="device-row" key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <span>{device.id}</span>
                  </div>
                  <div className="device-actions">
                    <span>{device.rssi === undefined ? 'RSSI n/a' : `${device.rssi} dBm`}</span>
                    <button onClick={() => connectToDevice(device)} disabled={!consentAccepted}>Connect</button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Heart Rate</h2>
              <p>Standard service 0x180D, characteristic 0x2A37.</p>
            </div>
          </div>
          <HeartRateGraph readings={heartRates.slice(-60)} />
        </section>
      </div>

      <section className="panel live-panel">
        <div className="section-heading">
          <div>
            <h2>Live Capture</h2>
            <p>Most recent packets, decoded when possible. Stored locally until you clear them.</p>
          </div>
          <div className="button-row">
            <button onClick={exportJson}>Show JSON</button>
            <button onClick={exportCsv}>Show CSV</button>
            <button onClick={clearPacketHistory}>Clear Packets</button>
          </div>
        </div>
        <PacketStream packets={packets} />
      </section>
      </details>

      <details className="advanced-panel">
        <summary>Advanced BLE Explorer</summary>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Service Explorer</h2>
            <p>{services.length} services, {flatCharacteristics.length} characteristics, {writableCount} writable.</p>
          </div>
          <button onClick={() => void subscribeAllNotifications()} disabled={!connected}>Subscribe All Notify</button>
        </div>

        <div className="service-list">
          {services.length === 0 ? (
            <EmptyState text="Connect to a device to enumerate services." />
          ) : (
            services.map((service) => (
              <article className={`service-block ${isKnownUuid(service.uuid) ? '' : 'unknown'}`} key={service.uuid}>
                <div className="service-title">
                  <div>
                    <h3>{uuidLabel(service.uuid)}</h3>
                    <code>{service.uuid}</code>
                  </div>
                  {!isKnownUuid(service.uuid) && <span className="tag warning">Unknown service</span>}
                </div>
                <div className="characteristic-table">
                  {service.characteristics.length === 0 ? (
                    <EmptyState text="No characteristics exposed for this service." />
                  ) : (
                    service.characteristics.map((characteristic) => (
                      <button
                        className={`characteristic-row ${selected?.uuid === characteristic.uuid && selected.serviceUuid === characteristic.serviceUuid ? 'selected' : ''}`}
                        key={`${characteristic.serviceUuid}-${characteristic.uuid}`}
                        onClick={() => setSelected(characteristic)}
                      >
                        <div>
                          <strong>{uuidLabel(characteristic.uuid)}</strong>
                          <code>{characteristic.uuid}</code>
                        </div>
                        <div className="properties">
                          <Property active={characteristic.properties.read} label="Read" />
                          <Property active={characteristic.properties.write || characteristic.properties.writeWithoutResponse} label="Write" tone="write" />
                          <Property active={characteristic.properties.notify} label="Notify" tone="notify" />
                          <Property active={characteristic.properties.indicate} label="Indicate" tone="notify" />
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <div className="content-grid">
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Characteristic Inspector</h2>
              <p>{selected ? `${uuidLabel(selected.serviceUuid)} / ${uuidLabel(selected.uuid)}` : 'Select a characteristic.'}</p>
            </div>
            <div className="button-row">
              <button onClick={() => selected && readCharacteristic(selected)} disabled={!selected?.properties.read}>Refresh</button>
              <button onClick={() => selected && bookmarkCharacteristic(selected)} disabled={!selected}>Bookmark</button>
            </div>
          </div>

          {selected ? (
            <div className="inspector">
              <LabeledValue label="Service UUID" value={selected.serviceUuid} />
              <LabeledValue label="Characteristic UUID" value={selected.uuid} />
              <LabeledValue label="Raw hex" value={selectedBytes.length ? bytesToHex(selectedBytes) : 'No value read yet'} />
              <LabeledValue label="Decimal" value={selectedBytes.length ? decimalValues(selectedBytes) : 'No value read yet'} />
              <LabeledValue label="UTF-8" value={selectedUtf8 ?? 'Not decodable as printable UTF-8'} />
            </div>
          ) : (
            <EmptyState text="Select a characteristic from the Service Explorer." />
          )}
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Write Testing Mode</h2>
              <p>Disabled by default. Every write requires confirmation and is logged.</p>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={writeMode} onChange={(event) => setWriteMode(event.target.checked)} />
              Enable
            </label>
          </div>
          <input
            className="hex-input"
            value={writeHex}
            onChange={(event) => setWriteHex(event.target.value)}
            disabled={!writeMode}
            placeholder="Hex bytes, for example: 01 ff 0a"
          />
          <button className="wide-button" onClick={sendWrite} disabled={!writeMode || !selected}>Send Hex Command</button>
        </section>
      </div>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Notification Logger & Packet Recorder</h2>
            <p>Read, notify, indicate, and write packets are timestamped and stored in IndexedDB.</p>
          </div>
          <div className="button-row">
            <button onClick={exportJson}>Export JSON</button>
            <button onClick={exportCsv}>Export CSV</button>
            <button onClick={clearPacketHistory}>Clear Packets</button>
          </div>
        </div>
        <PacketStream packets={packets} />
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Reverse Engineering View</h2>
            <p>Unknown, writable, and notify characteristics are highlighted for focused inspection.</p>
          </div>
        </div>
        <div className="reverse-grid">
          {flatCharacteristics
            .filter((item) => !isKnownUuid(item.serviceUuid) || item.properties.write || item.properties.writeWithoutResponse || item.properties.notify || item.properties.indicate)
            .map((item) => (
              <article className="reverse-item" key={`reverse-${item.serviceUuid}-${item.uuid}`}>
                <div>
                  <strong>{uuidLabel(item.uuid)}</strong>
                  <code>{item.serviceUuid}</code>
                  <code>{item.uuid}</code>
                </div>
                <div className="properties">
                  {!isKnownUuid(item.serviceUuid) && <span className="tag warning">Unknown</span>}
                  {(item.properties.write || item.properties.writeWithoutResponse) && <span className="tag write">Writable</span>}
                  {(item.properties.notify || item.properties.indicate) && <span className="tag notify">Notify</span>}
                  {item.subscribed && <span className="tag subscribed">Subscribed</span>}
                </div>
                <button onClick={() => bookmarkCharacteristic(item)}>Bookmark</button>
              </article>
            ))}
          {flatCharacteristics.length === 0 && <EmptyState text="Connect to a device to populate this view." />}
        </div>
        {bookmarks.length > 0 && (
          <div className="bookmarks">
            <h3>Bookmarks</h3>
            {bookmarks.slice(0, 20).map((bookmark, index) => (
              <code key={`${bookmark.timestamp}-${index}`}>{bookmark.label}: {bookmark.serviceUuid} / {bookmark.characteristicUuid}</code>
            ))}
          </div>
        )}
      </section>
      </details>
      </details>
    </main>
  );
}

function SignInScreen() {
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [rememberMe, setRememberMe] = useState(getRememberMePreference);
  const [submitting, setSubmitting] = useState(false);
  const [formStatus, setFormStatus] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFormStatus(mode === 'signIn' ? 'Checking your account...' : 'Creating your account...');
    setRememberMePreference(rememberMe);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const password = String(formData.get('password') ?? '');

    if (!email || !password) {
      setFormError('Enter your email and password.');
      setFormStatus(null);
      setSubmitting(false);
      return;
    }

    try {
      const result = await signIn('password', {
        flow: mode,
        email,
        password,
      });
      if (result.signingIn) {
        setFormStatus('Signed in. Loading your WHOOP workspace...');
        window.setTimeout(() => {
          window.location.reload();
        }, 800);
        return;
      }
      setFormStatus('Sign-in started. If the workspace does not load, refresh this page.');
    } catch (signInError) {
      setFormError(errorMessage(signInError));
      setFormStatus(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-copy">
          <p className="eyebrow">WHOOP BLE Health Capture</p>
          <h1>Sign in to connect your WHOOP</h1>
          <p>
            After sign-in and consent, Bluefy can connect to your band, capture browser-exposed Bluetooth packets, and automatically send them to your private Convex pipeline.
          </p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'} minLength={8} required />
          </label>
          <label className="toggle-line auth-remember">
            <input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />
            Keep me signed in
          </label>
          {formStatus && <p className="auth-status" aria-live="polite">{formStatus}</p>}
          {formError && <p className="auth-error">{formError}</p>}
          <button className="primary-action" type="submit" disabled={submitting}>
            {submitting ? 'Working...' : mode === 'signIn' ? 'Sign in' : 'Create account'}
          </button>
          <button type="button" className="text-action" onClick={() => setMode(mode === 'signIn' ? 'signUp' : 'signIn')}>
            {mode === 'signIn' ? 'Create an account' : 'Use existing account'}
          </button>
        </form>

        <div className="auth-disclaimers">
          <p>Not affiliated with WHOOP. No WHOOP API, cloud account, or credentials are used.</p>
          <p>Bluetooth access depends on the browser and the services your device exposes.</p>
          <p>Sleep, recovery, and strain values are local estimates, not official WHOOP scores or medical advice.</p>
        </div>
      </section>
    </main>
  );
}

function CloudSyncConsentPanel({
  accepted,
  loading,
  accepting,
  acceptedAt,
  onAccept,
}: {
  accepted: boolean;
  loading: boolean;
  accepting: boolean;
  acceptedAt?: string;
  onAccept: () => Promise<void>;
}) {
  if (loading) {
    return (
      <section className="consent-panel">
        <strong>Checking cloud sync disclosure</strong>
        <p>Loading your signed-in consent state before Bluetooth connect is enabled.</p>
      </section>
    );
  }

  if (accepted) {
    return (
      <section className="consent-panel accepted">
        <strong>Cloud sync disclosure accepted</strong>
        <p>
          Automatic Convex upload is enabled for new connected-session captures.
          {acceptedAt ? ` Accepted ${new Date(acceptedAt).toLocaleDateString()}.` : ''}
        </p>
      </section>
    );
  }

  return (
    <section className="consent-panel">
      <div>
        <strong>Cloud sync disclosure</strong>
        <p>
          New WHOOP Bluetooth data collected here will be uploaded to Convex under your signed-in account. Local device history is left in place.
        </p>
      </div>
      <ul>
        <li>This project is not affiliated with, endorsed by, or connected to WHOOP.</li>
        <li>The app does not use WHOOP credentials or the official WHOOP API.</li>
        <li>Scores and sleep details are independent estimates from browser-captured BLE data.</li>
        <li>Bluetooth data can be incomplete when Bluefy or the device hides services.</li>
      </ul>
      <button className="primary-action" type="button" onClick={() => void onAccept()} disabled={accepting}>
        {accepting ? 'Saving...' : 'Accept and enable sync'}
      </button>
    </section>
  );
}

function Metric({ label, value, subValue }: { label: string; value: string; subValue?: string }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {subValue && <small>{subValue}</small>}
    </article>
  );
}

function Signal({
  label,
  value,
  subValue,
  tone = 'neutral',
  statusLight,
}: {
  label: string;
  value: string;
  subValue?: string;
  tone?: 'good' | 'warn' | 'neutral';
  statusLight?: 'live' | 'offline';
}) {
  return (
    <article className={`signal ${tone}`}>
      <span className="signal-label">
        {label}
        {statusLight && <i className={`status-light ${statusLight}`} aria-label={statusLight === 'live' ? 'Live' : 'Waiting'} />}
      </span>
      <strong>{value}</strong>
      {subValue && <small>{subValue}</small>}
    </article>
  );
}

function TodayFeedPanel({
  report,
  latestHeartRate,
  latestBattery,
  packetCount,
  pipelineStatus,
  currentDate,
  alarmActive,
  alarmAvailable,
  alarmMessage,
  alarmTime,
  alarmTargetIso,
  onAlarmTimeChange,
  onToggleAlarm,
}: {
  report: HealthReport;
  latestHeartRate?: HeartRateReading;
  latestBattery?: BatteryReading;
  packetCount: number;
  pipelineStatus: PipelineSyncResult | null;
  currentDate: Date;
  alarmActive: boolean;
  alarmAvailable: boolean;
  alarmMessage: string;
  alarmTime: string;
  alarmTargetIso: string | null;
  onAlarmTimeChange: (value: string) => void;
  onToggleAlarm: () => void;
}) {
  const stats = report.standard.heartRateStats;
  const sleepDuration = report.sleep.estimatedDurationMinutes === undefined ? 'sleep window waiting' : `${formatDurationMinutes(report.sleep.estimatedDurationMinutes)} asleep`;
  const sleepEstimateDuration = SLEEP_ESTIMATE_REFERENCE.duration;
  const sleepEstimateWindow = SLEEP_ESTIMATE_REFERENCE.window;
  const sleepScore = packetCount === 0 ? 'Waiting' : `${report.sleep.localScore}/100`;
  const sleepTone = packetCount === 0 ? 'neutral' : report.sleep.dataConfidence >= 45 ? 'good' : 'warn';
  const recovery = calculateRecoveryProxy(report);
  const strain = calculateTextStrain(report);
  const pipelineLabel = pipelineStatus?.ok ? 'Synced' : packetCount > 0 ? 'Ready' : 'Waiting';
  const pipelineDetail = pipelineStatus?.message ?? (packetCount > 0 ? `${packetCount} packets ready for pipeline` : 'connect to collect data');
  const sleepStages = buildEstimatedSleepStages({
    ...report.sleep,
    estimatedDurationMinutes: SLEEP_ESTIMATE_REFERENCE.durationMinutes,
  });
  const todayDateShort = formatFeedDate(currentDate);
  const sleepEvidence = report.sleep.windowEvidencePoints > 0
    ? `${report.sleep.windowEvidencePoints} trusted backlog points`
    : 'Waiting for trusted backlog points';

  return (
    <details className="today-feed-panel" open>
      <summary>
        <span>
          Today Feed
          <small>{todayDateShort}</small>
        </span>
        <strong>{packetCount > 0 ? `${packetCount} packets collected` : 'waiting for data'}</strong>
      </summary>
      <div className="today-feed-grid">
        <Signal label="BPM" value={latestHeartRate ? `${latestHeartRate.bpm} bpm` : 'Waiting'} subValue={stats ? `${stats.min}/${stats.avg}/${stats.max} min/avg/max` : 'no HR packets yet'} tone={latestHeartRate ? 'good' : 'neutral'} />
        <Signal label="Sleep Score" value={sleepScore} subValue={`${report.sleep.confidenceLabel} confidence, ${sleepDuration}`} tone={sleepTone} />
        <Signal label="Recovery" value={recovery === undefined ? 'Waiting' : `${recovery}/100`} subValue={recovery === undefined ? 'needs sleep or HRV evidence' : 'local sleep + HR/HRV proxy'} tone={recovery === undefined ? 'neutral' : recovery >= 70 ? 'good' : recovery < 55 ? 'warn' : 'neutral'} />
        <Signal label="Strain" value={strain === undefined ? 'Waiting' : `${strain}/21`} subValue={stats ? 'local estimate from HR load' : 'needs HR data'} tone={strain === undefined ? 'neutral' : strain >= 10 ? 'warn' : 'good'} />
        <Signal label="RR / HRV" value={report.standard.rmssdMs === undefined ? 'Waiting' : `${report.standard.rmssdMs} ms`} subValue={`${report.standard.rrIntervals} RR intervals`} tone={report.standard.rmssdMs === undefined ? 'neutral' : 'good'} />
        <Signal label="Battery" value={latestBattery ? `${latestBattery.percentage}%` : 'Waiting'} subValue={latestBattery ? 'live battery packet' : 'no battery packet yet'} statusLight={latestBattery ? 'live' : 'offline'} tone={latestBattery ? 'good' : 'neutral'} />
        <Signal label="Data Confidence" value={`${report.confidence.score}/100`} subValue={report.confidence.label} tone={report.confidence.score >= 45 ? 'good' : packetCount ? 'warn' : 'neutral'} />
        <Signal label="Captured" value={String(packetCount)} subValue="local packets stored" tone={packetCount > 0 ? 'good' : 'neutral'} />
        <Signal label="Pipeline" value={pipelineLabel} subValue={pipelineDetail} tone={pipelineStatus?.ok ? 'good' : packetCount > 0 ? 'warn' : 'neutral'} />
      </div>
      <AlarmControl
        active={alarmActive}
        available={alarmAvailable}
        message={alarmMessage}
        alarmTime={alarmTime}
        targetIso={alarmTargetIso}
        onTimeChange={onAlarmTimeChange}
        onToggle={onToggleAlarm}
      />
      <section className="sleep-estimate-feed" aria-label="Estimated sleep details">
        <div className="sleep-feed-header">
          <div>
            <strong>Sleep Estimate</strong>
            <em>{SLEEP_ESTIMATE_REFERENCE.dateLong}</em>
            <span>{sleepEstimateWindow}</span>
          </div>
          <small>{report.sleep.confidenceLabel} confidence</small>
        </div>
        <div className="sleep-feed-summary">
          <div>
            <span>Time asleep</span>
            <strong>{sleepEstimateDuration}</strong>
          </div>
          <div>
            <span>Sleep window</span>
            <strong>{sleepEstimateWindow}</strong>
          </div>
          <div>
            <span>BLE evidence</span>
            <strong>{sleepEvidence}</strong>
          </div>
        </div>
        <div className="sleep-validation-card">
          <div>
            <span>Estimate line</span>
            <strong>{SLEEP_ESTIMATE_REFERENCE.date}</strong>
          </div>
          <p>
            {SLEEP_ESTIMATE_REFERENCE.window}, {SLEEP_ESTIMATE_REFERENCE.duration}. {SLEEP_ESTIMATE_REFERENCE.note}
          </p>
        </div>
        <div className="sleep-feed-stages">
          {sleepStages.map((stage) => (
            <div className="sleep-stage-row" key={stage.label}>
              <div>
                <span>{stage.label}</span>
                <strong>{stage.value}</strong>
              </div>
              <meter min="0" max="100" value={stage.percent} />
            </div>
          ))}
        </div>
        <p>{report.sleep.estimatedDurationMinutes === undefined ? 'Stages will appear after a morning reconnect provides enough overnight timestamps.' : 'Stage split is estimated from duration, HR stability, HRV proxy, and data confidence. It is not an official WHOOP sleep-stage decode.'}</p>
      </section>
    </details>
  );
}

function AlarmControl({
  active,
  available,
  message,
  alarmTime,
  targetIso,
  onTimeChange,
  onToggle,
}: {
  active: boolean;
  available: boolean;
  message: string;
  alarmTime: string;
  targetIso: string | null;
  onTimeChange: (value: string) => void;
  onToggle: () => void;
}) {
  const blocked = !available;
  const targetLabel = targetIso ? formatAlarmTarget(new Date(targetIso)) : null;
  return (
    <section className={`alarm-control ${active ? 'active' : blocked ? 'blocked' : 'idle'}`} aria-label="WHOOP band alarm">
      <div>
        <span className="alarm-title">
          WHOOP Band Alarm
          <i className={`status-light ${active ? 'live' : 'offline'}`} aria-label={active ? 'Alarm running' : 'Alarm off'} />
        </span>
        <strong>{active ? 'On' : blocked ? 'Unavailable' : 'Ready'}</strong>
        <small>{message}</small>
        {targetLabel && <small>Armed for {targetLabel}</small>}
      </div>
      <div className="alarm-actions">
        <label className="alarm-time-field">
          <span>Alarm time</span>
          <input
            type="time"
            value={alarmTime}
            onChange={(event) => onTimeChange(event.target.value)}
            disabled={blocked}
            aria-label="WHOOP band alarm time"
          />
        </label>
        <button type="button" onClick={onToggle} disabled={blocked} aria-pressed={active}>
          {active ? 'Turn Off' : 'Turn On'}
        </button>
      </div>
    </section>
  );
}

function LiveSyncTimeline({ steps, message }: { steps: LiveSyncStep[]; message: string }) {
  return (
    <section className="live-sync-panel" aria-label="Live sync progress">
      <div className="live-sync-header">
        <strong>Live process</strong>
        <span>{message}</span>
      </div>
      <div className="live-sync-steps">
        {steps.map((step) => (
          <article className={`live-sync-step ${step.state}`} key={step.label}>
            <span aria-hidden="true" />
            <div>
              <strong>{step.label}</strong>
              <small>{step.value}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function HealthDecoderPipelinePanel({
  localReport,
  importedReport,
  decoderStatus,
  onImport,
  onShowReport,
}: {
  localReport: HealthReport;
  importedReport: HealthReport | null;
  decoderStatus: string | null;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
  onShowReport: (report: HealthReport) => void;
}) {
  const report = importedReport ?? localReport;
  const sleepDuration = report.sleep.estimatedDurationMinutes === undefined ? 'Unknown' : formatDurationMinutes(report.sleep.estimatedDurationMinutes);
  const captureWindow = report.captureWindow
    ? `${formatDateTime(report.captureWindow.startIso)} - ${formatDateTime(report.captureWindow.endIso)}`
    : 'No packets';
  const reportTone = report.confidence.score >= 45 ? 'good' : report.packetCount ? 'warn' : 'neutral';

  return (
    <section className="panel decoder-pipeline-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Decoder Pipeline</p>
          <h2>WHOOP BLE Local Health Report</h2>
          <p>Turn local or imported Bluefy captures into the best possible browser-only health and sleep report.</p>
        </div>
        <div className="button-row">
          <label className="file-button">
            Import JSON
            <input type="file" accept="application/json,.json" onChange={onImport} />
          </label>
          <button onClick={() => onShowReport(report)} disabled={report.packetCount === 0}>Show Report</button>
        </div>
      </div>

      {decoderStatus && <p className="decoder-status">{decoderStatus}</p>}

      <div className="decode-summary">
        <Signal label="Report Source" value={report.sourceLabel} subValue={captureWindow} tone={reportTone} />
        <Signal label="Confidence" value={`${report.confidence.score}/100`} subValue={report.confidence.label} tone={reportTone} />
        <Signal label="Local Sleep Score" value={`${report.sleep.localScore}/100`} subValue={`${sleepDuration} asleep`} tone={report.sleep.dataConfidence >= 45 ? 'good' : 'warn'} />
      </div>

      <div className="pipeline-report-grid">
        <Signal label="HR" value={report.standard.heartRateStats ? `${report.standard.heartRateStats.min}/${report.standard.heartRateStats.avg}/${report.standard.heartRateStats.max} bpm` : 'Unavailable'} subValue={`${report.standard.heartRateReadings.length} valid readings`} />
        <Signal label="RR / HRV Proxy" value={report.standard.rmssdMs === undefined ? 'Unavailable' : `${report.standard.rmssdMs} ms`} subValue={`${report.standard.rrIntervals} RR intervals`} />
        <Signal label="Battery" value={report.standard.latestBattery === undefined ? 'Unavailable' : `${report.standard.latestBattery}%`} subValue={`${report.standard.batteryReadings.length} readings`} />
        <Signal label="Backlog" value={`${report.proprietary.historicalPackets} historical`} subValue={`${report.proprietary.packets} WHOOP proprietary packets`} tone={report.proprietary.historicalPackets ? 'good' : 'warn'} />
        <Signal label="CBOR Decode" value={`${report.proprietary.cborLikeFrames} frames`} subValue={`${report.proprietary.timestampFields} timestamp fields`} />
        <Signal label="Devices" value={report.deviceNames[0] ?? 'Unknown'} subValue={report.deviceNames.length > 1 ? `${report.deviceNames.length} device names` : undefined} />
      </div>

      <div className="report-list-grid">
        <div>
          <h3>Best Local Takeaways</h3>
          {report.insights.slice(0, 4).map((item) => <p key={item}>{item}</p>)}
        </div>
        <div>
          <h3>Limits</h3>
          {report.limitations.slice(0, 4).map((item) => <p key={item}>{item}</p>)}
        </div>
        <div>
          <h3>Next Capture</h3>
          {report.nextActions.slice(0, 4).map((item) => <p key={item}>{item}</p>)}
        </div>
      </div>
    </section>
  );
}

function MorningScanSummary({ packets, backlog }: { packets: PacketRecord[]; backlog: WhoopBacklogAnalysis }) {
  const sortedPackets = [...packets].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const firstPacket = sortedPackets[0];
  const lastPacket = sortedPackets[sortedPackets.length - 1];
  const heartRatePackets = packets.filter(
    (packet) => normalizeUuid(packet.serviceUuid) === HEART_RATE_SERVICE && normalizeUuid(packet.characteristicUuid) === HEART_RATE_MEASUREMENT,
  );
  const parsedHeartRates = heartRatePackets
    .map((packet) => parseHeartRateMeasurement(new DataView(new Uint8Array(packet.bytes).buffer)))
    .filter((reading): reading is NonNullable<ReturnType<typeof parseHeartRateMeasurement>> => Boolean(reading));
  const heartRateValues = parsedHeartRates.map((reading) => reading.bpm).filter((bpm) => bpm > 0);
  const averageHeartRate = heartRateValues.length
    ? Math.round(heartRateValues.reduce((sum, bpm) => sum + bpm, 0) / heartRateValues.length)
    : undefined;
  const rrIntervals = parsedHeartRates.reduce((count, reading) => count + (reading.rrIntervals?.length ?? 0), 0);
  const proprietary61080007 = packets.filter((packet) => normalizeUuid(packet.characteristicUuid) === '61080007-8d6d-82b8-614a-1c8cb0f8dcc6').length;
  const proprietary61080004 = packets.filter((packet) => normalizeUuid(packet.characteristicUuid) === '61080004-8d6d-82b8-614a-1c8cb0f8dcc6').length;
  const batteryPackets = packets.filter(
    (packet) => normalizeUuid(packet.serviceUuid) === BATTERY_SERVICE && normalizeUuid(packet.characteristicUuid) === BATTERY_LEVEL,
  );
  const latestBatteryPacket = [...batteryPackets].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  const latestBatteryPercent = latestBatteryPacket?.bytes[0];
  const foundHistorical = backlog.historicalRecords.length > 0;

  return (
    <section className="panel morning-summary-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Today</p>
          <h2>Morning Scan Summary</h2>
          <p>What came back from the WHOOP reconnect capture stored on this device.</p>
        </div>
        <span className={`health-chip ${foundHistorical ? 'good' : 'warn'}`}>
          {foundHistorical ? 'Backlog signal found' : 'No backlog signal yet'}
        </span>
      </div>

      <div className="morning-summary-grid">
        <Metric label="Capture Window" value={firstPacket && lastPacket ? `${formatDateTime(firstPacket.timestamp)} - ${formatDateTime(lastPacket.timestamp)}` : 'No capture'} />
        <Metric label="Total Packets" value={String(packets.length)} subValue="local records" />
        <Metric label="Heart-Rate Stream" value={`${heartRatePackets.length} packets`} subValue={averageHeartRate ? `${heartRateValues.length} valid, avg ${averageHeartRate} bpm` : 'No valid HR values'} />
        <Metric label="RR Intervals" value={String(rrIntervals)} subValue="HRV proxy source" />
        <Metric label="WHOOP 61080007" value={String(proprietary61080007)} subValue="main proprietary burst" />
        <Metric label="WHOOP 61080004" value={String(proprietary61080004)} subValue="secondary proprietary notify" />
        <Metric label="Historical Points" value={String(backlog.historicalRecords.length)} subValue={backlog.firstHistoricalIso ? `${formatDateTime(backlog.firstHistoricalIso)} - ${formatDateTime(backlog.lastHistoricalIso ?? backlog.firstHistoricalIso)}` : 'None decoded'} />
        <Metric label="Battery" value={latestBatteryPercent === undefined ? 'No reading' : `${latestBatteryPercent}%`} subValue={`${batteryPackets.length} battery packet${batteryPackets.length === 1 ? '' : 's'}`} />
      </div>

      <div className="scan-findings">
        <p>
          We got standard Bluetooth heart-rate data plus a small proprietary WHOOP burst. The proprietary packets include embedded overnight timestamps, which is the strongest evidence that WHOOP sent some local backlog-like data after reconnect.
        </p>
        <p>
          We did not get a readable official WHOOP sleep score or clear sleep-stage labels over Bluetooth. The local score below is our estimate from the data available in this browser.
        </p>
      </div>
    </section>
  );
}

function BacklogDecoder({ analysis, totalPackets }: { analysis: WhoopBacklogAnalysis; totalPackets: number }) {
  const historicalCount = analysis.historicalRecords.length;
  const proprietaryCount = analysis.proprietaryRecords.length;
  const verdict = historicalCount > 0
    ? `${historicalCount} historical packet${historicalCount === 1 ? '' : 's'} found`
    : proprietaryCount > 0
      ? 'WHOOP packets found, no historical timestamps yet'
      : 'Waiting for WHOOP backlog packets';
  const verdictTone = historicalCount > 0 ? 'good' : proprietaryCount > 0 ? 'warn' : 'neutral';
  const characteristicSummary = Object.entries(analysis.characteristicCounts)
    .map(([uuid, count]) => `${uuid.slice(0, 8)}: ${count}`)
    .join(' / ');

  return (
    <section className="panel backlog-panel">
      <div className="section-heading">
        <div>
          <h2>Backlog Decoder</h2>
          <p>Embedded timestamps found inside WHOOP proprietary packets stored locally on this device.</p>
        </div>
      </div>

      <div className="backlog-summary">
        <Signal label="Decoder Status" value={verdict} tone={verdictTone} />
        <Signal label="WHOOP Proprietary" value={String(proprietaryCount)} subValue={characteristicSummary || 'No 61080004 / 61080007 packets'} />
        <Signal label="Historical Window" value={analysis.firstHistoricalIso ? `${formatDateTime(analysis.firstHistoricalIso)} - ${formatDateTime(analysis.lastHistoricalIso ?? analysis.firstHistoricalIso)}` : 'None yet'} />
        <Signal label="Total Local Packets" value={String(totalPackets)} subValue="IndexedDB packet records" />
      </div>

      {analysis.groups.length === 0 ? (
        <EmptyState text="No historical embedded timestamps detected yet. Reconnect in the morning, start capture, then wait for proprietary packets." />
      ) : (
        <div className="backlog-groups">
          {analysis.groups.map((group, groupIndex) => (
            <details className="backlog-group" key={group.key} open={groupIndex === 0}>
              <summary>
                <span>{group.label}</span>
                <strong>{group.records.length} packet{group.records.length === 1 ? '' : 's'}</strong>
                <small>{formatDateTime(group.firstHistoricalIso)} - {formatDateTime(group.lastHistoricalIso)}</small>
              </summary>
              <div className="backlog-records">
                {group.records.slice(0, 8).map((record) => (
                  <article className="backlog-record" key={`${record.packet.timestamp}-${record.packet.rawHex}`}>
                    <div>
                      <span className="tag notify">{record.packet.characteristicUuid.slice(0, 8)}</span>
                      <time>{formatDateTime(record.packet.timestamp)}</time>
                    </div>
                    <strong>{record.historicalTimestamps.map((item) => `${formatDateTime(item.iso)} @${item.offset} ${item.endian}`).join(' / ')}</strong>
                    {record.textFragments.length > 0 && <code>{record.textFragments.join(' | ')}</code>}
                    <small>{record.packet.bytes.length} bytes, approx {record.historicalTimestamps[0]?.ageMinutes ?? 0} min before reconnect</small>
                  </article>
                ))}
                {group.records.length > 8 && <p className="backlog-more">{group.records.length - 8} more records in this group.</p>}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function ProprietaryDecodeLab({ frames }: { frames: WhoopProprietaryFrameDecode[] }) {
  const cborFrames = frames.filter((frame) => frame.cborOffset !== undefined);
  const timestampFields = frames.reduce((count, frame) => count + frame.cborFields.filter((field) => field.timestampIso).length, 0);
  const embeddedTimestampCount = frames.reduce((count, frame) => count + frame.embeddedTimestamps.length, 0);
  const labels = [...new Set(frames.flatMap((frame) => frame.textFragments).filter((fragment) => /harvard|boylston|[0-9]+\.[0-9]+\.[0-9]+/i.test(fragment)))].slice(0, 4);

  return (
    <section className="panel decode-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Reverse Engineering</p>
          <h2>Proprietary Decode Lab</h2>
          <p>CBOR-aware decode for WHOOP 61080004 / 61080007 packets. Field names are inferred, not official.</p>
        </div>
      </div>

      <div className="decode-summary">
        <Signal label="Frames" value={String(frames.length)} subValue={`${cborFrames.length} CBOR-like`} />
        <Signal label="Timestamp Fields" value={String(timestampFields)} subValue={`${embeddedTimestampCount} raw embedded hits`} tone={timestampFields ? 'good' : 'neutral'} />
        <Signal label="Text Labels" value={labels.length ? labels.join(' / ') : 'None'} />
      </div>

      {frames.length === 0 ? (
        <EmptyState text="No WHOOP proprietary frames captured yet." />
      ) : (
        <div className="decode-frame-list">
          {frames.slice(0, 10).map((frame, index) => (
            <details className="decode-frame" key={`${frame.packet.timestamp}-${frame.packet.rawHex}`} open={index < 2}>
              <summary>
                <div>
                  <strong>{frame.label}</strong>
                  <small>{formatDateTime(frame.packet.timestamp)} / {frame.packet.bytes.length} bytes / {frame.packet.characteristicUuid.slice(0, 8)}</small>
                </div>
                <span className={`health-chip ${frame.embeddedTimestamps.length ? 'good' : 'warn'}`}>
                  {frame.embeddedTimestamps.length ? `${frame.embeddedTimestamps.length} timestamp${frame.embeddedTimestamps.length === 1 ? '' : 's'}` : 'no timestamp'}
                </span>
              </summary>

              {frame.textFragments.length > 0 && (
                <div className="decode-line">
                  <span>Text</span>
                  <code>{frame.textFragments.join(' | ')}</code>
                </div>
              )}

              {frame.embeddedTimestamps.length > 0 && (
                <div className="decode-line">
                  <span>Embedded timestamps</span>
                  <code>{frame.embeddedTimestamps.map((item) => `${formatDateTime(item.iso)} @${item.offset} ${item.endian}`).join(' / ')}</code>
                </div>
              )}

              {frame.repeatedRuns.length > 0 && (
                <div className="decode-line">
                  <span>Repeated bytes</span>
                  <code>{frame.repeatedRuns.join(' / ')}</code>
                </div>
              )}

              <div className="decode-fields">
                {frame.cborFields.slice(0, 20).map((field) => (
                  <div className={field.timestampIso ? 'timestamp-field' : ''} key={`${field.path}-${field.value}`}>
                    <span>{field.path}</span>
                    <code>{field.value}</code>
                  </div>
                ))}
                {frame.cborFields.length === 0 && <EmptyState text="This frame did not contain a CBOR-like map in the first bytes." />}
              </div>
            </details>
          ))}
          {frames.length > 10 && <p className="backlog-more">{frames.length - 10} more proprietary frames not shown in this compact view.</p>}
        </div>
      )}
    </section>
  );
}

function LocalSleepAnalysisPanel({
  analysis,
}: {
  analysis: LocalSleepAnalysis;
}) {
  const scoreTone = analysis.dataConfidence >= 45 ? 'good' : 'warn';
  return (
    <section className="panel sleep-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Sleep</p>
          <h2>Local Sleep Check</h2>
          <p>Automatic estimate from trusted WHOOP BLE backlog timestamps. No manual sleep time is used.</p>
        </div>
      </div>

      <div className="sleep-score-row">
        <article className={`sleep-score ${scoreTone}`}>
          <span>Local Score</span>
          <strong>{analysis.localScore}</strong>
          <small>{analysis.confidenceLabel} confidence</small>
        </article>
        <Signal label="Estimated Start" value={analysis.estimatedStartIso ? formatDateTime(analysis.estimatedStartIso) : 'Unknown'} />
        <Signal label="Estimated End" value={analysis.estimatedEndIso ? formatDateTime(analysis.estimatedEndIso) : 'Unknown'} />
        <Signal label="Time Asleep" value={analysis.estimatedDurationMinutes === undefined ? 'Unknown' : formatDurationMinutes(analysis.estimatedDurationMinutes)} />
        <Signal label="BLE Evidence" value={analysis.windowEvidencePoints ? `${analysis.windowEvidencePoints} points` : 'Waiting'} subValue={analysis.windowSource === 'trusted_backlog' ? 'trusted backlog timestamps' : 'automatic decoder'} tone={analysis.windowEvidencePoints ? 'good' : 'neutral'} />
      </div>

      <div className="sleep-score-row">
        <Signal label="Overnight HR" value={analysis.hrStats ? `${analysis.hrStats.min}/${analysis.hrStats.avg}/${analysis.hrStats.max} bpm` : 'Unavailable'} subValue={analysis.hrStats ? 'min / avg / max' : 'No HR packets in sleep window'} />
        <Signal label="HR Samples" value={analysis.hrStats ? String(analysis.hrStats.samples) : '0'} />
        <Signal label="HRV Proxy" value={analysis.hrvProxy ? `${analysis.hrvProxy.rmssdMs} ms` : 'Unavailable'} subValue={analysis.hrvProxy ? `${analysis.hrvProxy.rrIntervals} RR intervals` : 'Not enough RR data'} />
        <Signal label="Data Confidence" value={`${analysis.dataConfidence}%`} subValue={analysis.confidenceLabel} />
      </div>

      <div className="sleep-breakdown">
        <h3>Why This Score</h3>
        {analysis.breakdown.map((item) => (
          <article className="sleep-breakdown-item" key={item.label}>
            <div>
              <strong>{item.label}</strong>
              <span>{item.weight}% weight</span>
            </div>
            <meter min="0" max="100" value={item.score} />
            <span>{item.score}/100</span>
            <p>{item.reason}</p>
          </article>
        ))}
      </div>

      <div className="sleep-notes">
        <p>
          Estimate line: {SLEEP_ESTIMATE_REFERENCE.date}, {SLEEP_ESTIMATE_REFERENCE.window}, {SLEEP_ESTIMATE_REFERENCE.duration}. {SLEEP_ESTIMATE_REFERENCE.note}
        </p>
        <p>
          This sleep window is inferred automatically from BLE data. The Bluetooth capture only proves the packets this browser received, so the official sleep score still cannot be recovered from this data alone.
        </p>
        {analysis.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
    </section>
  );
}

function ExportOutputPanel({
  exportOutput,
  copyStatus,
  onCopy,
  onClose,
}: {
  exportOutput: { filename: string; text: string; format: 'json' | 'csv' | 'md' } | null;
  copyStatus: string | null;
  onCopy: () => void;
  onClose: () => void;
}) {
  if (!exportOutput) {
    return null;
  }

  return (
    <div className="export-output">
      <div className="export-header">
        <div>
          <strong>Export Output</strong>
          <code>{exportOutput.filename}</code>
        </div>
        <div className="button-row">
          <button onClick={onCopy}>Copy</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      {copyStatus && <p className="copy-status">{copyStatus}</p>}
      <textarea
        className="export-textarea"
        readOnly
        value={exportOutput.text}
        aria-label={`${exportOutput.format.toUpperCase()} export output`}
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}

function PacketStream({ packets }: { packets: PacketRecord[] }) {
  return (
    <div className="packet-stream">
      {packets.length === 0 ? (
        <EmptyState text="No packets recorded yet." />
      ) : (
        packets.map((packet, index) => {
          const decoded = describePacket(packet);
          return (
            <article className="packet-row" key={`${packet.timestamp}-${index}`}>
              <div>
                <span className={`direction ${packet.direction}`}>{packet.direction}</span>
                <time>{new Date(packet.timestamp).toLocaleTimeString()}</time>
              </div>
              <code>{packet.serviceUuid} / {packet.characteristicUuid}</code>
              {decoded && <span className="packet-description">{decoded}</span>}
              <strong>{packet.rawHex || '(empty)'}</strong>
            </article>
          );
        })
      )}
    </div>
  );
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function formatFeedDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function getNextAlarmDate(timeValue: string): Date {
  const [hourText, minuteText] = timeValue.split(':');
  const hours = Number(hourText);
  const minutes = Number(minuteText);
  const now = new Date();
  const target = new Date(now);
  target.setSeconds(0, 0);
  target.setHours(Number.isFinite(hours) ? hours : 7, Number.isFinite(minutes) ? minutes : 0);

  if (target.getTime() <= now.getTime() + 30_000) {
    target.setDate(target.getDate() + 1);
  }

  return target;
}

function formatAlarmTarget(date: Date): string {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const targetDay = new Date(date);
  targetDay.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((targetDay.getTime() - today.getTime()) / 86_400_000);
  const dayLabel = dayDiff === 0 ? 'today' : dayDiff === 1 ? 'tomorrow' : formatDateTime(date.toISOString());
  return `${dayLabel} at ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function formatDurationMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) {
    return 'Unknown';
  }
  const safeMinutes = Math.round(minutes);
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  if (hours === 0) {
    return `${remainder}m`;
  }
  return `${hours}h ${String(remainder).padStart(2, '0')}m`;
}

function calculateTextStrain(report: HealthReport): number | undefined {
  const stats = report.standard.heartRateStats;
  if (!stats) {
    return undefined;
  }
  const elevatedAvg = Math.max(0, stats.avg - 60);
  const elevatedMax = Math.max(0, stats.max - 90);
  const packetFactor = Math.min(4, report.standard.heartRateReadings.length / 30);
  const strain = 1 + elevatedAvg / 7 + elevatedMax / 12 + packetFactor;
  return Math.round(Math.max(0, Math.min(21, strain)) * 10) / 10;
}

function calculateRecoveryProxy(report: HealthReport): number | undefined {
  const sleep = report.sleep.estimatedDurationMinutes === undefined ? undefined : report.sleep.localScore;
  const rmssd = report.sleep.hrvProxy?.rmssdMs ?? report.standard.rmssdMs;
  const hrStats = report.sleep.hrStats ?? report.standard.heartRateStats;

  if (sleep === undefined && rmssd === undefined && !hrStats) {
    return undefined;
  }

  const sleepComponent = sleep ?? 50;
  const hrvComponent = rmssd === undefined ? 50 : scoreRmssdProxy(rmssd);
  const hrComponent = hrStats ? clampNumber(Math.round(120 - Math.max(0, hrStats.avg - 45) * 2.1), 20, 100) : 50;
  const confidenceComponent = report.sleep.dataConfidence;
  return Math.round(
    sleepComponent * 0.48
    + hrvComponent * 0.24
    + hrComponent * 0.2
    + confidenceComponent * 0.08,
  );
}

function scoreRmssdProxy(rmssdMs: number): number {
  if (rmssdMs >= 70) {
    return 100;
  }
  if (rmssdMs >= 45) {
    return Math.round(80 + ((rmssdMs - 45) / 25) * 20);
  }
  if (rmssdMs >= 25) {
    return Math.round(55 + ((rmssdMs - 25) / 20) * 25);
  }
  return clampNumber(Math.round(rmssdMs * 2), 10, 55);
}

interface EstimatedSleepStage {
  label: string;
  value: string;
  percent: number;
}

function buildEstimatedSleepStages(analysis: LocalSleepAnalysis): EstimatedSleepStage[] {
  const duration = analysis.estimatedDurationMinutes;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0 || duration > 14 * 60) {
    return [
      { label: 'Awake', value: 'Waiting', percent: 0 },
      { label: 'Light', value: 'Waiting', percent: 0 },
      { label: 'Deep', value: 'Waiting', percent: 0 },
      { label: 'REM', value: 'Waiting', percent: 0 },
    ];
  }

  const confidenceAdjust = analysis.dataConfidence >= 75 ? 1 : analysis.dataConfidence >= 45 ? 0.7 : 0.35;
  const hrRange = analysis.hrStats ? analysis.hrStats.max - analysis.hrStats.min : 18;
  const stableHrBonus = Math.max(-4, Math.min(5, (18 - hrRange) / 4)) * confidenceAdjust;
  const hrvBonus = analysis.hrvProxy ? Math.max(-3, Math.min(4, (analysis.hrvProxy.rmssdMs - 35) / 10)) * confidenceAdjust : 0;
  const shortSleepPenalty = duration < 360 ? 4 : duration > 540 ? 2 : 0;

  const awakePercent = clampNumber(10 + shortSleepPenalty - stableHrBonus, 6, 22);
  const deepPercent = clampNumber(15 + stableHrBonus + hrvBonus, 8, 24);
  const remPercent = clampNumber(22 + Math.max(0, hrvBonus / 2), 16, 28);
  const lightPercent = Math.max(0, 100 - awakePercent - deepPercent - remPercent);

  return [
    makeSleepStage('Awake', awakePercent, duration),
    makeSleepStage('Light', lightPercent, duration),
    makeSleepStage('Deep', deepPercent, duration),
    makeSleepStage('REM', remPercent, duration),
  ];
}

function makeSleepStage(label: string, percent: number, durationMinutes: number): EstimatedSleepStage {
  const minutes = Math.round(durationMinutes * (percent / 100));
  return {
    label,
    value: formatDurationMinutes(minutes),
    percent: Math.round(percent),
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildWhoopAlarmPacket(unixSeconds: number, counter: number): Uint8Array {
  const packet = new Uint8Array(20);
  packet.set([0xaa, 0x10, 0x00, 0x57, 0x23, counter & 0xff, 0x42, 0x01]);
  const view = new DataView(packet.buffer);
  view.setUint32(8, unixSeconds >>> 0, true);
  const checksum = calculateWhoopCrc32(packet.slice(0, 16));
  view.setUint32(16, checksum, true);
  return packet;
}

function calculateWhoopCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (0xedb88320 ^ (crc >>> 1)) >>> 0 : crc >>> 1;
    }
  }
  return (crc ^ 0xf43f44ac) >>> 0;
}

function buildLiveSyncSteps({
  connected,
  packetCount,
  pipelineSyncing,
  pipelineStatus,
  autoSyncStage,
}: {
  connected: boolean;
  packetCount: number;
  pipelineSyncing: boolean;
  pipelineStatus: PipelineSyncResult | null;
  autoSyncStage: AutoSyncStage;
}): LiveSyncStep[] {
  const failed = autoSyncStage === 'error' || pipelineStatus?.status === 'failed';
  return [
    {
      label: 'Bluetooth',
      value: connected ? 'Connected' : autoSyncStage === 'connecting' ? 'Connecting' : 'Waiting',
      state: connected ? 'done' : autoSyncStage === 'connecting' ? 'active' : 'waiting',
    },
    {
      label: 'Capture',
      value: packetCount > 0 ? `${packetCount} packets` : autoSyncStage === 'capturing' || autoSyncStage === 'subscribing' ? 'Listening' : 'Waiting',
      state: packetCount > 0 ? 'done' : autoSyncStage === 'capturing' || autoSyncStage === 'subscribing' ? 'active' : 'waiting',
    },
    {
      label: 'Process',
      value: packetCount > 0 ? 'Data processed' : 'Waiting for data',
      state: autoSyncStage === 'processing' ? 'active' : packetCount > 0 ? 'done' : 'waiting',
    },
    {
      label: 'Send',
      value: pipelineStatus?.ok ? 'Complete' : pipelineSyncing || autoSyncStage === 'sending' ? 'Uploading' : failed ? 'Needs retry' : 'Waiting',
      state: pipelineStatus?.ok ? 'done' : pipelineSyncing || autoSyncStage === 'sending' ? 'active' : failed ? 'error' : 'waiting',
    },
  ];
}

interface ReportedSleepWindow {
  startLabel: string;
  endLabel: string;
  durationMinutes: number;
  durationLabel: string;
}

function emptyReportedSleepWindow(): ReportedSleepWindow {
  return {
    startLabel: 'Not set',
    endLabel: 'Not set',
    durationMinutes: 0,
    durationLabel: 'Not set',
  };
}

function Property({ active, label, tone }: { active: boolean; label: string; tone?: 'write' | 'notify' }) {
  return <span className={`property ${active ? 'active' : ''} ${tone ?? ''}`}>{label}</span>;
}

function LabeledValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="labeled-value">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function HeartRateGraph({ readings }: { readings: HeartRateReading[] }) {
  const width = 320;
  const height = 130;
  const values = readings.map((reading) => reading.bpm);
  const min = values.length ? Math.max(30, Math.min(...values) - 5) : 40;
  const max = values.length ? Math.max(...values, 120) + 5 : 140;
  const range = Math.max(1, max - min);
  const points = values
    .map((value, index) => {
      const x = values.length <= 1 ? 0 : (index / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="graph-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Live heart rate graph">
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} />
        <line x1="0" y1="1" x2={width} y2="1" />
        {points && <polyline points={points} />}
      </svg>
      <div className="graph-labels">
        <span>{readings.length ? `${Math.min(...values)} min` : 'No readings'}</span>
        <span>{readings.length ? `${Math.max(...values)} max` : 'Waiting for 0x2A37'}</span>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
