import * as _ from "lodash";
import * as Objects from "@paperbits/common/objects";
import { IObjectStorage, Query, Operator, OrderDirection, Page } from "@paperbits/common/persistence";
import { Bag } from "@paperbits/common/bag";
import { FirebaseService } from "../services/firebaseService";

const pageSize = 7;

export class FirebaseObjectStorage implements IObjectStorage {
    constructor(private readonly firebaseService: FirebaseService) { }

    private normalizeDataObject<T>(dataObject: T): void {
        if (dataObject instanceof Object) {
            Object.keys(dataObject).forEach(key => {
                const child = dataObject[key];

                if (child instanceof Object) {
                    this.normalizeDataObject(child);
                }
                else if (child === undefined) {
                    dataObject[key] = null;
                }
            });
        }
    }

    private searchInResult<T>(searchObj: unknown, query?: Query<T>): Bag<T> {
        const searchResultObject: Bag<T> = {};
        let collection = Object.values(searchObj);

        if (query) {
            if (query.filters.length > 0) {
                collection = collection.filter(x => {
                    let meetsCriteria = true;

                    for (const filter of query.filters) {
                        const property = x[filter.left];

                        if (typeof filter.right === "boolean") {
                            if (filter.operator !== Operator.equals) {
                                console.warn("Boolean query operator can be only equals");
                                meetsCriteria = false;
                                return;
                            }

                            if (((property === undefined || property === false) && filter.right === true) ||
                                ((filter.right === undefined || filter.right === false) && property === true)) {
                                meetsCriteria = false;
                            }
                            continue;
                        }

                        if (!property) {
                            meetsCriteria = false;
                            continue;
                        }

                        const left = x[filter.left].toUpperCase();
                        const right = filter.right.toUpperCase();
                        const operator = filter.operator;

                        switch (operator) {
                            case Operator.contains:
                                if (!left.includes(right)) {
                                    meetsCriteria = false;
                                }
                                break;

                            case Operator.equals:
                                if (left !== right) {
                                    meetsCriteria = false;
                                }
                                break;

                            default:
                                throw new Error("Cannot translate operator into Firebase Realtime Database query.");
                        }
                    }

                    return meetsCriteria;
                });
            }

            if (query.orderingBy) {
                const property = query.orderingBy;

                collection = collection.sort((x, y) => {
                    const a = x[property].toUpperCase();
                    const b = y[property].toUpperCase();
                    const modifier = query.orderDirection === OrderDirection.accending ? 1 : -1;

                    if (a > b) {
                        return modifier;
                    }

                    if (a < b) {
                        return -modifier;
                    }

                    return 0;
                });
            }
        }

        collection.forEach(item => {
            const segments = item.key.split("/");
            const key = segments[1];

            Objects.setValue(key, searchResultObject, item);
            Objects.cleanupObject(item); // Ensure all "undefined" are cleaned up
        });

        return searchResultObject;
    }

    public async addObject<T>(path: string, dataObject: T): Promise<void> {
        this.normalizeDataObject(dataObject);

        try {
            const databaseRef = await this.firebaseService.getDatabaseRef();

            if (path) {
                await databaseRef.child(path).set(dataObject);
            }
            else {
                await databaseRef.update(dataObject);
            }
        }
        catch (error) {
            throw new Error(`Could not add object '${path}'. ${error.stack || error.message}.`);
        }
    }

    public async getObject<T>(path: string): Promise<T> {
        try {
            const databaseRef = await this.firebaseService.getDatabaseRef();
            const snapshot = await databaseRef.child(path).once("value");

            return snapshot.val();
        }
        catch (error) {
            throw new Error(`Could not retrieve object '${path}'. ${error.stack || error.message}.`);
        }
    }

    public async deleteObject(path: string): Promise<void> {
        try {
            const databaseRef = await this.firebaseService.getDatabaseRef();
            databaseRef.child(path).remove();
        }
        catch (error) {
            throw new Error(`Could not delete object '${path}'. ${error.stack || error.message}.`);
        }
    }

    public async updateObject<T>(path: string, dataObject: T): Promise<void> {
        this.normalizeDataObject(dataObject);

        try {
            const databaseRef = await this.firebaseService.getDatabaseRef();
            return await databaseRef.child(path).update(dataObject);
        }
        catch (error) {
            throw new Error(`Could not update object '${path}'. ${error.stack || error.message}`);
        }
    }

    public async searchObjects<T>(path: string, query: Query<T>): Promise<Page<T>> {
        try {
            const databaseRef = await this.firebaseService.getDatabaseRef();
            const pathRef = databaseRef.child(path);
            const snapshot = await pathRef.once("value");
            const searchObj = snapshot.val();
            
            let collection: any[] = Object.values(searchObj);

            if (query) {
                if (query.filters.length > 0) {
                    collection = collection.filter(x => {
                        let meetsCriteria = true;

                        for (const filter of query.filters) {
                            let left = Objects.getObjectAt<any>(filter.left, x);
                            let right = filter.right;

                            if (left === undefined) {
                                meetsCriteria = false;
                                continue;
                            }

                            if (typeof left === "string") {
                                left = left.toUpperCase();
                            }

                            if (typeof right === "string") {
                                right = right.toUpperCase();
                            }

                            const operator = filter.operator;

                            switch (operator) {
                                case Operator.contains:
                                    if (left && !left.includes(right)) {
                                        meetsCriteria = false;
                                    }
                                    break;

                                case Operator.equals:
                                    if (left !== right) {
                                        meetsCriteria = false;
                                    }
                                    break;

                                default:
                                    throw new Error("Cannot translate operator into Firebase Realtime Database query.");
                            }
                        }

                        return meetsCriteria;
                    });
                }

                if (query.orderingBy) {
                    const property = query.orderingBy;

                    collection = collection.sort((x, y) => {
                        const a = Objects.getObjectAt<any>(property, x);
                        const b = Objects.getObjectAt<any>(property, y);
                        const modifier = query.orderDirection === OrderDirection.accending ? 1 : -1;

                        if (a > b) {
                            return modifier;
                        }

                        if (a < b) {
                            return -modifier;
                        }

                        return 0;
                    });
                }
            }

            const skip = 0;
            const take = pageSize;
            const value = collection.slice(skip, skip + take);

            return new StaticPage(value, collection, skip, take);
        }
        catch (error) {
            throw new Error(`Could not search object '${path}'. ${error.stack || error.message}.`);
        }
    }

    public async saveChanges(delta: Object): Promise<void> {
        console.log("Saving changes...");

        const saveTasks = [];
        const keys = [];

        Object.keys(delta).map(key => {
            const firstLevelObject = delta[key];

            Object.keys(firstLevelObject).forEach(subkey => {
                keys.push(`${key}/${subkey}`);
            });
        });

        keys.forEach(key => {
            const changeObject = Objects.getObjectAt(key, delta);

            if (changeObject) {
                saveTasks.push(this.updateObject(key, changeObject));
            }
            else {
                saveTasks.push(this.deleteObject(key));
            }
        });

        await Promise.all(saveTasks);
    }
}

class StaticPage<T> implements Page<T> {
    constructor(
        public readonly value: T[],
        private readonly collection: any,
        private readonly skip: number,
        private readonly take: number
    ) {
        if (skip + take > this.collection.length) {
            this.takeNext = null;
        }
    }

    public async takePrev?(): Promise<Page<T>> {
        throw new Error("Not implemented");
    }

    public async takeNext?(): Promise<Page<T>> {
        const value = this.collection.slice(this.skip, this.skip + pageSize);
        const skipNext = this.skip + pageSize;
        const takeNext = pageSize || this.take;

        const nextPage = new StaticPage<T>(value, this.collection, skipNext, takeNext);


        return nextPage;
    }
}