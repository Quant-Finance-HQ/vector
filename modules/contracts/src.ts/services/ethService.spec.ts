import { expect, MemoryStoreService } from "@connext/vector-utils";
import { Contract } from "ethers";
import pino from "pino";

import { AddressBook } from "../addressBook";
import { alice, createTestChannel, getTestAddressBook, provider } from "../tests";

import { EthereumChainService } from "./ethService";

describe("EthereumChainService", () => {
  let addressBook: AddressBook;
  let channel: Contract;
  let chainId: number;
  let chainService: EthereumChainService;

  beforeEach(async () => {
    addressBook = await getTestAddressBook();
    channel = await createTestChannel(addressBook);
    chainId = (await provider.getNetwork()).chainId;
    chainService = new EthereumChainService(
      new MemoryStoreService(),
      { [chainId]: provider },
      alice.privateKey,
      pino(),
    );
  });

  it("should be created without error", async () => {
    expect(channel.address).to.be.ok;
    expect(chainService).to.be.ok;
  });
});
