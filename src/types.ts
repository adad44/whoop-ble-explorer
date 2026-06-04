export type Direction = 'read' | 'notify' | 'indicate' | 'write';

export interface SeenDevice {
  id: string;
  name: string;
  rssi?: number;
  lastSeen: number;
  device?: BluetoothDevice;
}

export interface CharacteristicInfo {
  uuid: string;
  serviceUuid: string;
  characteristic: BluetoothRemoteGATTCharacteristic;
  properties: {
    read: boolean;
    write: boolean;
    writeWithoutResponse: boolean;
    notify: boolean;
    indicate: boolean;
  };
  value?: DataView;
  decodeError?: string;
  subscribed?: boolean;
}

export interface ServiceInfo {
  uuid: string;
  service: BluetoothRemoteGATTService;
  characteristics: CharacteristicInfo[];
}

export interface PacketRecord {
  id?: number;
  sessionId: string;
  deviceId: string;
  deviceName: string;
  serviceUuid: string;
  characteristicUuid: string;
  direction: Direction;
  rawHex: string;
  bytes: number[];
  timestamp: string;
}

export interface HeartRateReading {
  id?: number;
  sessionId: string;
  deviceId: string;
  bpm: number;
  timestamp: string;
  energyExpended?: number;
  rrIntervals?: number[];
}

export interface BatteryReading {
  id?: number;
  sessionId: string;
  deviceId: string;
  percentage: number;
  timestamp: string;
}

export interface Bookmark {
  id?: number;
  deviceId: string;
  serviceUuid: string;
  characteristicUuid?: string;
  label: string;
  timestamp: string;
}
