/* eslint-disable @typescript-eslint/naming-convention */
import { DependencyContainer } from "tsyringe";

import { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import { IPostSptLoadMod } from "@spt/models/external/IPostSptLoadMod";
import { IPostDBLoadMod } from "@spt/models/external/IPostDBLoadMod";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { DatabaseServer } from "@spt/servers/DatabaseServer";

import config from "../config.json";
import { IHandbookItem } from "@spt/models/eft/common/tables/IHandbookBase";
import { ITemplateItem } from "@spt/models/eft/common/tables/ITemplateItem";
import { BaseClasses } from "@spt/models/enums/BaseClasses";
import { RagfairPriceService } from "@spt/services/RagfairPriceService";

class Mod implements IPreSptLoadMod, IPostSptLoadMod, IPostDBLoadMod {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public preSptLoad(container: DependencyContainer): void {
    // Not doing anything here
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public postDBLoad(container: DependencyContainer): void {
    // Not doing anything here
  }

  public postSptLoad(container: DependencyContainer): void {
    this.mellonFleaMarket(container);
  }

  private mellonFleaMarket(container: DependencyContainer): void {
    const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
    const logger = container.resolve<ILogger>("WinstonLogger");
    const ragfair = container.resolve<RagfairPriceService>(
      "RagfairPriceService"
    );

    if (config.debug) {
      this.ezLog(
        logger,
        "MellonFleaMarket debug mode enabled, printing values!"
      );
      this.ezLog(logger, `${JSON.stringify(config, null, 2)}`);
    }

    const itemTable = databaseServer.getTables().templates.items;
    const handbook = databaseServer.getTables().templates.handbook.Items;
    const prices = databaseServer.getTables().templates.prices;
    const items = databaseServer.getTables().templates.items;

    let updatedItemCount = 0;
    for (const itemIdx in itemTable) {
      let updated = false;
      const item = itemTable[itemIdx];
      if (!item._props) {
        continue;
      }

      const basePrice = this.getBasePrice(handbook, items, item, logger);
      const initialFleaPrice = this.getFleaPrice(prices, item._id);

      if (basePrice <= -1 || isNaN(basePrice)) {
        // No handbook price, so no idea what to set the flea price to /shrug
        continue;
      }
      if (initialFleaPrice <= -1 || isNaN(basePrice)) {
        // No flea price, so we can't update it
        // TODO: better invalid item checks so we can skip soft armor parts but not missing items that should have prices
        continue;
      }

      const baseValueMult =
        config.baseValueMult *
        (1 + (Math.random() * 2 - 1) * config.baseValueRandomization);
      let newFleaPrice = basePrice * baseValueMult;

      // Apply category multipliers
      const categoryMult =
        config.categoryMultipliers[this.getCategoryFromName(item._parent)];
      if (categoryMult !== 1) {
        newFleaPrice *= categoryMult;
        if (config.debug || config.categoryMultLogging) {
          this.ezLog(
            logger,
            `Applying category multiplier to ${item._props.Name}: ${categoryMult} = ${newFleaPrice}`
          );
        }
      }

      // Apply bounds
      const lowerBound = basePrice * config.lowerBoundMult;
      const upperBound = basePrice * config.upperBoundMult;
      if (newFleaPrice < lowerBound) {
        newFleaPrice = lowerBound;
        if (config.debug || config.boundLogging) {
          this.ezLog(
            logger,
            `Setting ${
              item._props.Name
            } flea price to lower bound: ${lowerBound}; was ${
              basePrice * baseValueMult
            }`
          );
        }
      } else if (newFleaPrice > upperBound) {
        newFleaPrice = upperBound;
        if (config.debug || config.boundLogging) {
          this.ezLog(
            logger,
            `Setting ${
              item._props.Name
            } flea price to upper bound: ${upperBound}; was ${
              basePrice * baseValueMult
            }`
          );
        }
      }

      newFleaPrice = Math.round(newFleaPrice);
      if (newFleaPrice !== initialFleaPrice) {
        this.setFleaPrice(prices, item._id, newFleaPrice);
        updated = true;
      }

      if (updated) {
        updatedItemCount++;
      }
    }

    // Set the prices, idk
    const tables = databaseServer.getTables();
    tables.templates.prices = prices;
    databaseServer.setTables(tables);
    ragfair.refreshStaticPrices();
    ragfair.refreshDynamicPrices();

    // Log the changed count
    this.ezLog(logger, `Done running! Updated ${updatedItemCount} items`);
    if (config.rerunTimeSeconds > 0) {
      this.ezLog(logger, `Re-running in ${config.rerunTimeSeconds} seconds...`);
      setTimeout(() => {
        this.mellonFleaMarket(container);
      }, config.rerunTimeSeconds * 1000);
    }
  }

  private ezLog(logger: ILogger, message: string): void {
    logger.log(`MellonFleaMarket: ${message}`, "white");
  }

  private getHandbookPrice(handbook: IHandbookItem[], id: string): number {
    for (const obj of handbook) {
      if (obj.Id === id) {
        return obj.Price ?? -1;
      }
    }
    return -1;
  }

  private getFleaPrice(prices: Record<string, number>, id: string): number {
    return prices[id] ?? -1;
  }

  private setFleaPrice(
    prices: Record<string, number>,
    id: string,
    price: number
  ): void {
    prices[id] = price;
  }

  private getBasePrice(
    handbook: IHandbookItem[],
    items: any,
    item: ITemplateItem,
    logger: ILogger
  ): number {
    const id = item._id;
    if (!item || !id) {
      return -1;
    }
    let basePrice = this.getHandbookPrice(handbook, id);
    // Handling built in armor plates
    if (item._props.Slots) {
      const initialPrice = basePrice;
      for (const slot of item._props.Slots) {
        if (
          slot._required &&
          slot._props &&
          slot?._props?.filters &&
          slot?._props?.filters[0]?.Plate
        ) {
          const requiredItem = items[slot?._props?.filters[0]?.Plate];
          if (requiredItem) {
            const requiredPrice = this.getBasePrice(
              handbook,
              items,
              requiredItem,
              logger
            );
            if (requiredPrice > 0) {
              basePrice += requiredPrice;
            }
          }
        }
      }
      if (
        (config.debug || config.requiredPartsLogging) &&
        initialPrice !== basePrice
      ) {
        this.ezLog(
          logger,
          `Updating ${item._props.Name} base price from ${initialPrice} to ${basePrice} because of slots!`
        );
      }
    }
    return basePrice;
  }

  private getCategoryFromName(name: string): string {
    // I hate this
    const BaseClasses = {
      "5422acb9af1c889c16000029": "WEAPON",
      "55818b014bdc2ddc698b456b": "UBGL",
      "5448e54d4bdc2dcc718b4568": "ARMOR",
      "57bef4c42459772e8d35a53b": "ARMORED_EQUIPMENT",
      "616eb7aea207f41933308f46": "REPAIR_KITS",
      "5a341c4086f77401f2541505": "HEADWEAR",
      "5a341c4686f77469e155819e": "FACECOVER",
      "5448e5284bdc2dcb718b4567": "VEST",
      "5448e53e4bdc2d60728b4567": "BACKPACK",
      "566162e44bdc2d3f298b4573": "COMPOUND",
      "5448e5724bdc2ddf718b4568": "VISORS",
      "5448e8d04bdc2ddf718b4569": "FOOD",
      "56ea9461d2720b67698b456f": "GAS_BLOCK",
      "55818b1d4bdc2d5b648b4572": "RAIL_COVER",
      "5448e8d64bdc2dce718b4568": "DRINK",
      "5448eb774bdc2d0a728b4567": "BARTER_ITEM",
      "5448ecbe4bdc2d60728b4568": "INFO",
      "5448f39d4bdc2d0a728b4568": "MEDKIT",
      "5448f3a14bdc2d27728b4569": "DRUGS",
      "5448f3a64bdc2d60728b456a": "STIMULATOR",
      "5448f3ac4bdc2dce718b4569": "MEDICAL",
      "57864c8c245977548867e7f1": "MEDICAL_SUPPLIES",
      "5448fe124bdc2da5018b4567": "MOD",
      "550aa4154bdc2dd8348b456b": "FUNCTIONAL_MOD",
      "5d650c3e815116009f6201d2": "FUEL",
      "55802f3e4bdc2de7118b4584": "GEAR_MOD",
      "55818a594bdc2db9688b456a": "STOCK",
      "55818af64bdc2d5b648b4570": "FOREGRIP",
      "55802f4a4bdc2ddb688b4569": "MASTER_MOD",
      "55818b224bdc2dde698b456f": "MOUNT",
      "5448fe394bdc2d0d028b456c": "MUZZLE",
      "5448fe7a4bdc2d6f028b456b": "SIGHTS",
      "543be5664bdc2dd4348b4569": "MEDS",
      "567849dd4bdc2d150f8b456e": "MAP",
      "543be5dd4bdc2deb348b4569": "MONEY",
      "5a2c3a9486f774688b05e574": "NIGHTVISION",
      "5d21f59b6dbe99052b54ef83": "THERMAL_VISION",
      "543be5e94bdc2df1348b4568": "KEY",
      "5c99f98d86f7745c314214b3": "KEY_MECHANICAL",
      "5c164d2286f774194c5e69fa": "KEYCARD",
      "543be5f84bdc2dd4348b456a": "EQUIPMENT",
      "543be6564bdc2df4348b4568": "THROW_WEAPON",
      "543be6674bdc2df1348b4569": "FOOD_DRINK",
      "5447b5cf4bdc2d65278b4567": "PISTOL",
      "617f1ef5e8b54b0998387733": "REVOLVER",
      "5447b5e04bdc2d62278b4567": "SMG",
      "5447b5f14bdc2d61278b4567": "ASSAULT_RIFLE",
      "5447b5fc4bdc2d87278b4567": "ASSAULT_CARBINE",
      "5447b6094bdc2dc3278b4567": "SHOTGUN",
      "5447b6194bdc2d67278b4567": "MARKSMAN_RIFLE",
      "5447b6254bdc2dc3278b4568": "SNIPER_RIFLE",
      "5447bed64bdc2d97278b4568": "MACHINE_GUN",
      "5447bedf4bdc2d87278b4568": "GRENADE_LAUNCHER",
      "5447bee84bdc2dc3278b4569": "SPECIAL_WEAPON",
      "5447e0e74bdc2d3c308b4567": "SPEC_ITEM",
      "627a137bf21bc425b06ab944": "SPRING_DRIVEN_CYLINDER",
      "5447e1d04bdc2dff2f8b4567": "KNIFE",
      "5485a8684bdc2da71d8b4567": "AMMO",
      "543be5cb4bdc2deb348b4568": "AMMO_BOX",
      "566965d44bdc2d814c8b4571": "LOOT_CONTAINER",
      "5448bf274bdc2dfc2f8b456a": "MOB_CONTAINER",
      "566168634bdc2d144c8b456c": "SEARCHABLE_ITEM",
      "566abbb64bdc2d144c8b457d": "STASH",
      "6050cac987d3f925bf016837": "SORTING_TABLE",
      "5671435f4bdc2d96058b4569": "LOCKABLE_CONTAINER",
      "5795f317245977243854e041": "SIMPLE_CONTAINER",
      "55d720f24bdc2d88028b456d": "INVENTORY",
      "567583764bdc2d98058b456e": "STATIONARY_CONTAINER",
      "557596e64bdc2dc2118b4571": "POCKETS",
      "5b3f15d486f77432d0509248": "ARMBAND",
      "57864a3d24597754843f8721": "JEWELRY",
      "57864a66245977548f04a81f": "ELECTRONICS",
      "57864ada245977548638de91": "BUILDING_MATERIAL",
      "57864bb7245977548b3b66c2": "TOOL",
      "57864c322459775490116fbf": "HOUSEHOLD_GOODS",
      "57864e4c24597754843f8723": "LUBRICANT",
      "57864ee62459775490116fc1": "BATTERY",
      "55818add4bdc2d5b648b456f": "ASSAULT_SCOPE",
      "55818b164bdc2ddc698b456c": "TACTICAL_COMBO",
      "55818b084bdc2d5b648b4571": "FLASHLIGHT",
      "5448bc234bdc2d3c308b4569": "MAGAZINE",
      "55818b0e4bdc2dde698b456e": "LIGHT_LASER_DESIGNATOR",
      "550aa4bf4bdc2dd6348b456b": "FLASH_HIDER",
      "55818ad54bdc2ddc698b4569": "COLLIMATOR",
      "55818ac54bdc2d5b648b456e": "IRON_SIGHT",
      "55818acf4bdc2dde698b456b": "COMPACT_COLLIMATOR",
      "550aa4af4bdc2dd4348b456e": "COMPENSATOR",
      "55818ae44bdc2dde698b456c": "OPTIC_SCOPE",
      "55818aeb4bdc2ddc698b456a": "SPECIAL_SCOPE",
      "590c745b86f7743cc433c5f2": "OTHER",
      "550aa4cd4bdc2dd8348b456c": "SILENCER",
      "61605ddea09d851a0a0c1bbc": "PORTABLE_RANGE_FINDER",
      "610720f290b75a49ff2e5e25": "CYLINDER_MAGAZINE",
      "5a74651486f7744e73386dd1": "AUXILIARY_MOD",
      "55818afb4bdc2dde698b456d": "BIPOD",
      "5645bcb74bdc2ded0b8b4578": "HEADPHONES",
      "62f109593b54472778797866": "RANDOM_LOOT_CONTAINER",
      "5661632d4bdc2d903d8b456b": "STACKABLE_ITEM",
      "65649eb40bf0ed77b8044453": "BUILT_IN_INSERTS",
      "644120aa86ffbe10ee032b6f": "ARMOR_PLATE",
      "64b69b0c8f3be32ed22682f8": "CULTIST_AMULET",
      "62e9103049c018f425059f38": "RADIO_TRANSMITTER",
      "55818a104bdc2db9688b4569": "HANDGUARD",
      "55818a684bdc2ddd698b456d": "PISTOL_GRIP",
      "55818a304bdc2db5418b457d": "RECEIVER",
      "555ef6e44bdc2de9068b457e": "BARREL",
      "55818a6f4bdc2db9688b456b": "CHARGING_HANDLE",
      "550aa4dd4bdc2dc9348b4569 ": "COMB_MUZZLE_DEVICE ",
      "63da6da4784a55176c018dba": "HIDEOUT_AREA_CONTAINER",
    };
    if (BaseClasses[name]) {
      return BaseClasses[name];
    }
    return "UNKNOWN";
  }
}

export const mod = new Mod();
