export interface DataHandler {
	(data: Buffer): Promise<Buffer>
}

export interface MoneyHandler {
	(amount: string): Promise<void>
}

export interface Channel {
}
