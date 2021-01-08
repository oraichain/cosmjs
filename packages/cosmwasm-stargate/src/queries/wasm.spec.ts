/* eslint-disable @typescript-eslint/naming-convention */
import { sha256 } from "@cosmjs/crypto";
import { fromAscii, fromHex, toAscii, toHex } from "@cosmjs/encoding";
import { Coin, coin, coins, logs, StdFee } from "@cosmjs/launchpad";
import { DirectSecp256k1HdWallet, OfflineDirectSigner, Registry } from "@cosmjs/proto-signing";
import {
  assertIsBroadcastTxSuccess,
  BroadcastTxResponse,
  parseRawLog,
  SigningStargateClient,
} from "@cosmjs/stargate";
import { assert } from "@cosmjs/utils";
import Long from "long";

import { cosmwasm } from "../codec";
import { SigningCosmWasmClient } from "../signingcosmwasmclient";
import {
  alice,
  base64Matcher,
  bech32AddressMatcher,
  ContractUploadInstructions,
  getHackatom,
  makeRandomAddress,
  makeWasmClient,
  pendingWithoutWasmd,
  wasmd,
  wasmdEnabled,
} from "../testutils.spec";

const { MsgExecuteContract, MsgInstantiateContract, MsgStoreCode } = cosmwasm.wasm.v1beta1;

const registry = new Registry([
  ["/cosmwasm.wasm.v1beta1.MsgExecuteContract", MsgExecuteContract],
  ["/cosmwasm.wasm.v1beta1.MsgStoreCode", MsgStoreCode],
  ["/cosmwasm.wasm.v1beta1.MsgInstantiateContract", MsgInstantiateContract],
]);

async function uploadContract(
  signer: OfflineDirectSigner,
  contract: ContractUploadInstructions,
): Promise<BroadcastTxResponse> {
  const memo = "My first contract on chain";
  const theMsg = {
    typeUrl: "/cosmwasm.wasm.v1beta1.MsgStoreCode",
    value: MsgStoreCode.create({
      sender: alice.address0,
      wasmByteCode: contract.data,
      source: contract.source || "",
      builder: contract.builder || "",
    }),
  };
  const fee: StdFee = {
    amount: coins(5000000, "ucosm"),
    gas: "89000000",
  };
  const firstAddress = (await signer.getAccounts())[0].address;
  const client = await SigningStargateClient.connectWithWallet(wasmd.endpoint, signer, { registry });
  return client.signAndBroadcast(firstAddress, [theMsg], fee, memo);
}

async function instantiateContract(
  signer: OfflineDirectSigner,
  codeId: number,
  beneficiaryAddress: string,
  transferAmount?: readonly Coin[],
): Promise<BroadcastTxResponse> {
  const memo = "Create an escrow instance";
  const theMsg = {
    typeUrl: "/cosmwasm.wasm.v1beta1.MsgInstantiateContract",
    value: MsgInstantiateContract.create({
      sender: alice.address0,
      codeId: Long.fromNumber(codeId),
      label: "my escrow",
      initMsg: toAscii(
        JSON.stringify({
          verifier: alice.address0,
          beneficiary: beneficiaryAddress,
        }),
      ),
      initFunds: transferAmount ? [...transferAmount] : [],
    }),
  };
  const fee: StdFee = {
    amount: coins(5000000, "ucosm"),
    gas: "89000000",
  };

  const firstAddress = (await signer.getAccounts())[0].address;
  const client = await SigningStargateClient.connectWithWallet(wasmd.endpoint, signer, { registry });
  return client.signAndBroadcast(firstAddress, [theMsg], fee, memo);
}

async function executeContract(
  signer: OfflineDirectSigner,
  contractAddress: string,
  msg: Record<string, unknown>,
): Promise<BroadcastTxResponse> {
  const memo = "Time for action";
  const theMsg = {
    typeUrl: "/cosmwasm.wasm.v1beta1.MsgExecuteContract",
    value: MsgExecuteContract.create({
      sender: alice.address0,
      contract: contractAddress,
      msg: toAscii(JSON.stringify(msg)),
      sentFunds: [],
    }),
  };
  const fee: StdFee = {
    amount: coins(5000000, "ucosm"),
    gas: "89000000",
  };

  const firstAddress = (await signer.getAccounts())[0].address;
  const client = await SigningCosmWasmClient.connectWithWallet(wasmd.endpoint, signer, { registry });
  return client.signAndBroadcast(firstAddress, [theMsg], fee, memo);
}

describe("WasmExtension", () => {
  const hackatom = getHackatom();
  const hackatomConfigKey = toAscii("config");
  let hackatomCodeId: number | undefined;
  let hackatomContractAddress: string | undefined;

  beforeAll(async () => {
    if (wasmdEnabled()) {
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(alice.mnemonic, undefined, "wasm");
      const result = await uploadContract(wallet, hackatom);
      assertIsBroadcastTxSuccess(result);
      hackatomCodeId = Number.parseInt(
        JSON.parse(result.rawLog!)[0].events[0].attributes.find(
          (attribute: any) => attribute.key === "code_id",
        ).value,
        10,
      );

      const instantiateResult = await instantiateContract(wallet, hackatomCodeId, makeRandomAddress());
      assertIsBroadcastTxSuccess(instantiateResult);
      hackatomContractAddress = JSON.parse(instantiateResult.rawLog!)[0]
        .events.find((event: any) => event.type === "message")
        .attributes.find((attribute: any) => attribute.key === "contract_address").value;
    }
  });

  describe("listCodeInfo", () => {
    it("has recently uploaded contract as last entry", async () => {
      pendingWithoutWasmd();
      assert(hackatomCodeId);
      const client = await makeWasmClient(wasmd.endpoint);
      const { codeInfos } = await client.unverified.wasm.listCodeInfo();
      assert(codeInfos);
      const lastCode = codeInfos[codeInfos.length - 1];
      expect(lastCode.codeId!.toNumber()).toEqual(hackatomCodeId);
      expect(lastCode.creator).toEqual(alice.address0);
      expect(lastCode.source).toEqual(hackatom.source);
      expect(lastCode.builder).toEqual(hackatom.builder);
      expect(toHex(lastCode.dataHash!)).toEqual(toHex(sha256(hackatom.data)));
    });
  });

  describe("getCode", () => {
    it("contains fill code information", async () => {
      pendingWithoutWasmd();
      assert(hackatomCodeId);
      const client = await makeWasmClient(wasmd.endpoint);
      const { codeInfo, data } = await client.unverified.wasm.getCode(hackatomCodeId);
      expect(codeInfo!.codeId!.toNumber()).toEqual(hackatomCodeId);
      expect(codeInfo!.creator).toEqual(alice.address0);
      expect(codeInfo!.source).toEqual(hackatom.source);
      expect(codeInfo!.builder).toEqual(hackatom.builder);
      expect(toHex(codeInfo!.dataHash!)).toEqual(toHex(sha256(hackatom.data)));
      expect(data).toEqual(hackatom.data);
    });
  });

  // TODO: move listContractsByCodeId tests out of here
  describe("getContractInfo", () => {
    it("works", async () => {
      pendingWithoutWasmd();
      assert(hackatomCodeId);
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(alice.mnemonic, undefined, "wasm");
      const client = await makeWasmClient(wasmd.endpoint);
      const beneficiaryAddress = makeRandomAddress();
      const transferAmount = coins(707707, "ucosm");

      // create new instance and compare before and after
      const { contractInfos: existingContractInfos } = await client.unverified.wasm.listContractsByCodeId(
        hackatomCodeId,
      );
      assert(existingContractInfos);
      for (const { address, contractInfo } of existingContractInfos) {
        expect(address).toMatch(bech32AddressMatcher);
        expect(contractInfo!.codeId!.toNumber()).toEqual(hackatomCodeId);
        expect(contractInfo!.creator).toMatch(bech32AddressMatcher);
        expect(contractInfo!.label).toMatch(/^.+$/);
      }

      const result = await instantiateContract(wallet, hackatomCodeId, beneficiaryAddress, transferAmount);
      assertIsBroadcastTxSuccess(result);
      const myAddress = JSON.parse(result.rawLog!)[0]
        .events.find((event: any) => event.type === "message")
        .attributes!.find((attribute: any) => attribute.key === "contract_address").value;

      const { contractInfos: newContractInfos } = await client.unverified.wasm.listContractsByCodeId(
        hackatomCodeId,
      );
      assert(newContractInfos);
      expect(newContractInfos.length).toEqual(existingContractInfos.length + 1);
      const newContract = newContractInfos[newContractInfos.length - 1];
      expect({ ...newContract.contractInfo }).toEqual({
        codeId: Long.fromNumber(hackatomCodeId, true),
        creator: alice.address0,
        label: "my escrow",
      });

      const { contractInfo } = await client.unverified.wasm.getContractInfo(myAddress);
      assert(contractInfo);
      expect({ ...contractInfo }).toEqual({
        codeId: Long.fromNumber(hackatomCodeId, true),
        creator: alice.address0,
        label: "my escrow",
      });
      expect(contractInfo.admin).toEqual("");
    });

    it("rejects for non-existent address", async () => {
      pendingWithoutWasmd();
      assert(hackatomCodeId);
      const client = await makeWasmClient(wasmd.endpoint);
      const nonExistentAddress = makeRandomAddress();
      await expectAsync(client.unverified.wasm.getContractInfo(nonExistentAddress)).toBeRejectedWithError(
        /not found/i,
      );
    });
  });

  describe("getContractCodeHistory", () => {
    it("can list contract history", async () => {
      pendingWithoutWasmd();
      assert(hackatomCodeId);
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(alice.mnemonic, undefined, "wasm");
      const client = await makeWasmClient(wasmd.endpoint);
      const beneficiaryAddress = makeRandomAddress();
      const transferAmount = coins(707707, "ucosm");

      // create new instance and compare before and after
      const result = await instantiateContract(wallet, hackatomCodeId, beneficiaryAddress, transferAmount);
      assertIsBroadcastTxSuccess(result);

      const myAddress = JSON.parse(result.rawLog!)[0]
        .events.find((event: any) => event.type === "message")
        .attributes!.find((attribute: any) => attribute.key === "contract_address").value;

      const history = await client.unverified.wasm.getContractCodeHistory(myAddress);
      assert(history.entries);
      expect(history.entries).toContain(
        jasmine.objectContaining({
          codeId: Long.fromNumber(hackatomCodeId, true),
          operation:
            cosmwasm.wasm.v1beta1.ContractCodeHistoryOperationType.CONTRACT_CODE_HISTORY_OPERATION_TYPE_INIT,
          msg: toAscii(
            JSON.stringify({
              verifier: alice.address0,
              beneficiary: beneficiaryAddress,
            }),
          ),
        }),
      );
    });

    it("returns empty list for non-existent address", async () => {
      pendingWithoutWasmd();
      assert(hackatomCodeId);
      const client = await makeWasmClient(wasmd.endpoint);
      const nonExistentAddress = makeRandomAddress();
      const history = await client.unverified.wasm.getContractCodeHistory(nonExistentAddress);
      expect(history.entries).toEqual([]);
    });
  });

  describe("getAllContractState", () => {
    it("can get all state", async () => {
      pendingWithoutWasmd();
      assert(hackatomContractAddress);
      const client = await makeWasmClient(wasmd.endpoint);
      const { models } = await client.unverified.wasm.getAllContractState(hackatomContractAddress);
      assert(models);
      expect(models.length).toEqual(1);
      const data = models[0];
      expect(data.key).toEqual(hackatomConfigKey);
      const value = JSON.parse(fromAscii(data.value!));
      expect(value.verifier).toMatch(base64Matcher);
      expect(value.beneficiary).toMatch(base64Matcher);
    });

    it("rejects for non-existent address", async () => {
      pendingWithoutWasmd();
      const client = await makeWasmClient(wasmd.endpoint);
      const nonExistentAddress = makeRandomAddress();
      await expectAsync(client.unverified.wasm.getAllContractState(nonExistentAddress)).toBeRejectedWithError(
        /not found/i,
      );
    });
  });

  describe("queryContractRaw", () => {
    it("can query by key", async () => {
      pendingWithoutWasmd();
      assert(hackatomContractAddress);
      const client = await makeWasmClient(wasmd.endpoint);
      const raw = await client.unverified.wasm.queryContractRaw(hackatomContractAddress, hackatomConfigKey);
      assert(raw.data, "must get result");
      const model = JSON.parse(fromAscii(raw.data));
      expect(model.verifier).toMatch(base64Matcher);
      expect(model.beneficiary).toMatch(base64Matcher);
    });

    it("returns empty object for missing key", async () => {
      pendingWithoutWasmd();
      assert(hackatomContractAddress);
      const client = await makeWasmClient(wasmd.endpoint);
      const response = await client.unverified.wasm.queryContractRaw(
        hackatomContractAddress,
        fromHex("cafe0dad"),
      );
      expect({ ...response }).toEqual({});
    });

    it("returns null for non-existent address", async () => {
      pendingWithoutWasmd();
      const client = await makeWasmClient(wasmd.endpoint);
      const nonExistentAddress = makeRandomAddress();
      await expectAsync(
        client.unverified.wasm.queryContractRaw(nonExistentAddress, hackatomConfigKey),
      ).toBeRejectedWithError(/not found/i);
    });
  });

  describe("queryContractSmart", () => {
    it("can make smart queries", async () => {
      pendingWithoutWasmd();
      assert(hackatomContractAddress);
      const client = await makeWasmClient(wasmd.endpoint);
      const request = { verifier: {} };
      const result = await client.unverified.wasm.queryContractSmart(hackatomContractAddress, request);
      expect(result).toEqual({ verifier: alice.address0 });
    });

    it("throws for invalid query requests", async () => {
      pendingWithoutWasmd();
      assert(hackatomContractAddress);
      const client = await makeWasmClient(wasmd.endpoint);
      const request = { nosuchkey: {} };
      await expectAsync(
        client.unverified.wasm.queryContractSmart(hackatomContractAddress, request),
      ).toBeRejectedWithError(/Error parsing into type hackatom::contract::QueryMsg: unknown variant/i);
    });

    it("throws for non-existent address", async () => {
      pendingWithoutWasmd();
      const client = await makeWasmClient(wasmd.endpoint);
      const nonExistentAddress = makeRandomAddress();
      const request = { verifier: {} };
      await expectAsync(
        client.unverified.wasm.queryContractSmart(nonExistentAddress, request),
      ).toBeRejectedWithError(/not found/i);
    });
  });

  describe("broadcastTx", () => {
    it("can upload, instantiate and execute wasm", async () => {
      pendingWithoutWasmd();
      const wallet = await DirectSecp256k1HdWallet.fromMnemonic(alice.mnemonic, undefined, wasmd.prefix);
      const client = await makeWasmClient(wasmd.endpoint);

      const transferAmount = [coin(1234, "ucosm"), coin(321, "ustake")];
      const beneficiaryAddress = makeRandomAddress();

      let codeId: number;

      // upload
      {
        const result = await uploadContract(wallet, getHackatom());
        assertIsBroadcastTxSuccess(result);
        const parsedLogs = logs.parseLogs(parseRawLog(result.rawLog));
        const codeIdAttr = logs.findAttribute(parsedLogs, "message", "code_id");
        codeId = Number.parseInt(codeIdAttr.value, 10);
        expect(codeId).toBeGreaterThanOrEqual(1);
        expect(codeId).toBeLessThanOrEqual(200);
        expect(result.data!.length).toEqual(1);
        console.log(`Raw Store Data: [${result.data![0].data}]`);
        console.log(`Code ID From events: ${codeId}`);
        expect({ ...result.data![0] }).toEqual({
          msgType: "store-code",
          // TODO: protobuf de/encode here `{codeId: codeId}`
          // https://github.com/CosmWasm/wasmd/blob/5f8c246d25e8be640fb401fda4bbf82db37e9e90/x/wasm/internal/types/tx.proto#L41-L45
          data: toAscii(`${codeId}`),
        });
      }

      let contractAddress: string;

      // instantiate
      {
        const result = await instantiateContract(wallet, codeId, beneficiaryAddress, transferAmount);
        assertIsBroadcastTxSuccess(result);
        const parsedLogs = logs.parseLogs(parseRawLog(result.rawLog));
        const contractAddressAttr = logs.findAttribute(parsedLogs, "message", "contract_address");
        contractAddress = contractAddressAttr.value;
        const amountAttr = logs.findAttribute(parsedLogs, "transfer", "amount");
        expect(amountAttr.value).toEqual("1234ucosm,321ustake");
        expect(result.data!.length).toEqual(1);
        console.log(`Raw Init Data: [${result.data![0].data}]`);
        console.log(`Addr From events (ascii bytes): [${toAscii(contractAddress)}]`);
        expect({ ...result.data![0] }).toEqual({
          msgType: "instantiate",
          // TODO: protobuf de/encode here `{address: contractAddress}`
          // https://github.com/CosmWasm/wasmd/blob/5f8c246d25e8be640fb401fda4bbf82db37e9e90/x/wasm/internal/types/tx.proto#L62-L66
          data: toAscii(contractAddress),
        });

        const balanceUcosm = await client.bank.balance(contractAddress, "ucosm");
        expect(balanceUcosm).toEqual(transferAmount[0]);
        const balanceUstake = await client.bank.balance(contractAddress, "ustake");
        expect(balanceUstake).toEqual(transferAmount[1]);
      }

      // execute
      {
        const result = await executeContract(wallet, contractAddress, { release: {} });
        assertIsBroadcastTxSuccess(result);
        expect(result.data!.length).toEqual(1);
        console.log(`Raw Execute Data: 0x${toHex(result.data![0].data!)}`);
        console.log(`Expected Contract Data: 0xf00baa`);
        expect({ ...result.data![0] }).toEqual({
          msgType: "execute",
          // TODO: protobuf de/encode here `{data: [0xf0, 0x0b, 0xaa]}`
          // https://github.com/CosmWasm/wasmd/blob/5f8c246d25e8be640fb401fda4bbf82db37e9e90/x/wasm/internal/types/tx.proto#L80-L84
          data: fromHex("F00BAA"),
        });
        const parsedLogs = logs.parseLogs(parseRawLog(result.rawLog));
        const wasmEvent = parsedLogs.find(() => true)?.events.find((e) => e.type === "wasm");
        assert(wasmEvent, "Event of type wasm expected");
        expect(wasmEvent.attributes).toContain({ key: "action", value: "release" });
        expect(wasmEvent.attributes).toContain({
          key: "destination",
          value: beneficiaryAddress,
        });

        // Verify token transfer from contract to beneficiary
        const beneficiaryBalanceUcosm = await client.bank.balance(beneficiaryAddress, "ucosm");
        expect(beneficiaryBalanceUcosm).toEqual(transferAmount[0]);
        const beneficiaryBalanceUstake = await client.bank.balance(beneficiaryAddress, "ustake");
        expect(beneficiaryBalanceUstake).toEqual(transferAmount[1]);
      }
    });
  });
});
