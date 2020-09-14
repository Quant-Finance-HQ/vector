export interface IMessagingService {
  connect(): Promise<void>;
  send(to: string, msg: any): Promise<void>;
  onReceive(subject: string, callback: (msg: any) => void): Promise<void>;
  request(subject: string, timeout: number, data: any): Promise<any>;
  publish(subject: string, data: any): Promise<void>;
  subscribe(subject: string, cb: (data: any) => any): Promise<void>;
  unsubscribe(subject: string): Promise<void>;
}

export type MessagingConfig = {
  clusterId?: string;
  messagingUrl: string | string[];
  options?: any;
  privateKey?: string;
  publicKey?: string;
  token?: string;
};
