export {};

declare global {
  interface Navigator {
    bluetooth?: Bluetooth;
  }

  interface Bluetooth extends EventTarget {
    requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
    requestLEScan?(options?: BluetoothLEScanOptions): Promise<BluetoothLEScan>;
    getAvailability?(): Promise<boolean>;
  }

  interface BluetoothLEScanOptions {
    acceptAllAdvertisements?: boolean;
    filters?: BluetoothLEScanFilter[];
    keepRepeatedDevices?: boolean;
  }

  interface BluetoothLEScanFilter {
    name?: string;
    namePrefix?: string;
    services?: BluetoothServiceUUID[];
    manufacturerData?: BluetoothManufacturerDataFilter[];
    serviceData?: BluetoothServiceDataFilter[];
  }

  interface BluetoothManufacturerDataFilter {
    companyIdentifier: number;
    dataPrefix?: BufferSource;
    mask?: BufferSource;
  }

  interface BluetoothServiceDataFilter {
    service: BluetoothServiceUUID;
    dataPrefix?: BufferSource;
    mask?: BufferSource;
  }

  interface BluetoothLEScan {
    active: boolean;
    stop(): void;
  }

  interface BluetoothAdvertisingEvent extends Event {
    readonly device: BluetoothDevice;
    readonly name?: string;
    readonly uuids?: string[];
    readonly rssi?: number;
    readonly txPower?: number;
    readonly appearance?: number;
    readonly manufacturerData?: BluetoothManufacturerDataMap;
    readonly serviceData?: BluetoothServiceDataMap;
  }

  type BluetoothManufacturerDataMap = Map<number, DataView>;
  type BluetoothServiceDataMap = Map<string, DataView>;
}
