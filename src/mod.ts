import { DependencyContainer } from "tsyringe";

import { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import { IPostSptLoadMod } from "@spt/models/external/IPostSptLoadMod";
import { IPostDBLoadMod } from "@spt/models/external/IPostDBLoadMod";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { DatabaseServer } from "@spt/servers/DatabaseServer";

import config from "../config.json";

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
    const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
    const logger = container.resolve<ILogger>("WinstonLogger");

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

    let updatedItemCount = 0;
    for (const itemIdx in itemTable) {
      let updated = false;
      const item = itemTable[itemIdx];
      if (!item._props) {
        continue;
      }

      const handbookPrice = this.getHandbookPrice(handbook, item._id);
      const initialFleaPrice = this.getFleaPrice(prices, item._id);

      if (handbookPrice <= -1) {
        // No handbook price, so no idea what to set the flea price to /shrug
        continue;
      }
      if (initialFleaPrice <= -1) {
        // No flea price, so we can't update it
        continue;
      }

      // config.baseValueRandomization should be able to be negative or positive
      const baseValueMult =
        config.baseValueMult *
        (1 + (Math.random() * 2 - 1) * config.baseValueRandomization);
      let newFleaPrice = handbookPrice * baseValueMult;

      // Apply bounds
      const lowerBound = handbookPrice * config.lowerBoundMult;
      const upperBound = handbookPrice * config.upperBoundMult;
      if (newFleaPrice < lowerBound) {
        newFleaPrice = lowerBound;
        if (config.debug) {
          this.ezLog(
            logger,
            `Setting ${item._props.Name} flea price to lower bound: ${lowerBound}`
          );
        }
      } else if (newFleaPrice > upperBound) {
        newFleaPrice = upperBound;
        if (config.debug) {
          this.ezLog(
            logger,
            `Setting ${item._props.Name} flea price to upper bound: ${upperBound}`
          );
        }
      }

      newFleaPrice = Math.round(newFleaPrice);
      if (newFleaPrice !== initialFleaPrice) {
        this.setFleaPrice(prices, item._id, newFleaPrice);
        updated = true;
        if (config.debug) {
          this.ezLog(
            logger,
            `Updating ${item._props.Name} flea price from ${initialFleaPrice} to ${newFleaPrice}`
          );
        }
      }

      if (updated) {
        updatedItemCount++;
      }
    }
    // Log the changed count
    this.ezLog(logger, `Updated ${updatedItemCount} items`);
  }

  private ezLog(logger: ILogger, message: string): void {
    logger.log(`MellonTweaks: ${message}`, "white");
  }

  private getHandbookPrice(handbook: any, id: string): number {
    for (const obj of handbook) {
      if (obj.Id === id) {
        return obj.Price ?? -1;
      }
    }
    return -1;
  }

  private getFleaPrice(prices: any, id: string): number {
    return prices[id] ?? -1;
  }

  private setFleaPrice(prices: any, id: string, price: number): void {
    prices[id] = price;
  }
}

export const mod = new Mod();
