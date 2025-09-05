# Trading Bot Dashboard "BOTPY"

BOTPY is a comprehensive web-based dashboard designed to monitor, control, and analyze a multi-pair automated crypto trading bot operating on USDT pairs. It provides a real-time, user-friendly interface to track market opportunities, manage active positions, review performance, and fine-tune the trading strategy. It supports a phased approach to live trading with `Virtual`, `Real (Paper)`, and `Real (Live)` modes.

## ✨ Key Features

-   **Multiple Trading Modes**: A safe, phased approach to live trading.
    -   `Virtual`: 100% simulation. Safe for testing and strategy optimization.
    -   `Real (Paper)`: Uses real Binance API keys for a live data feed but **simulates** trades without risking capital. The perfect final test.
    -   `Real (Live)`: Executes trades with real funds on your Binance account.
-   **Hybrid Strategy Engine**: The bot is truly market-agnostic. It simultaneously scans for three distinct types of high-probability setups on every pair: "Precision" (Squeeze 🎯) for calm-before-the-storm scenarios, "Momentum" (Impulse 🔥) for established breakouts, and the high-risk "Ignition" (Anomaly 🚀) for explosive market anomalies.
-   **Dynamic Adaptive Profiles**: Instead of a static configuration, the bot can operate as a "Tactical Chameleon". When enabled, it analyzes the market's volatility and trend strength for each specific trade and automatically selects the most effective management profile: "Sniper", "Scalper", or "Volatility Hunter".
-   **Live Dashboard**: Offers an at-a-glance overview of key performance indicators (KPIs) such as balance, open positions, total Profit & Loss (P&L), and win rate.
-   **Real-time Market Scanner**: Displays the results of the market analysis, showing pairs with active trade signals (🎯, 🔥, or 🚀), including ADX and ATR% data used by the adaptive logic.
-   **Detailed Trade History**: Provides a complete log of all past trades with powerful sorting, filtering, and data export (CSV) capabilities, now including strategy type for performance analysis.
-   **Fully Configurable**: Every parameter of the strategy is easily adjustable through a dedicated settings page with helpful tooltips.

---

## 🎨 Application Pages & Design

The application is designed with a dark, modern aesthetic (`bg-[#0c0e12]`), using an `Inter` font for readability and `Space Mono` for numerical data. The primary accent color is a vibrant yellow/gold (`#f0b90b`), used for interactive elements and highlights, with green and red reserved for clear financial indicators.

### 🔐 Login Page
-   **Purpose**: Provides secure access to the dashboard.

### 📊 Dashboard
-   **Purpose**: The main control center, providing a high-level summary of the bot's status and performance.
-   **Key Components**: Stat Cards (Balance, Open Positions, P&L), Performance Chart, and an Active Positions Table.

### 📡 Scanner
-   **Purpose**: To display the real-time results of the hybrid market analysis, showing which pairs are potential trade candidates.
-   **Layout**: A data-dense table with sortable columns reflecting the strategy.
-   **Key Columns**:
    -   `Signal`: Displays the type of setup detected: 🎯 for "Precision", 🔥 for "Momentum", or 🚀 for "Ignition".
    -   `Symbol`, `Price` (with live green/red flashes).
    -   `Score`: The final strategic score, displayed as a colored badge.
    -   `Conditions`: Visual dots representing the status of each strategic filter.
    -   `Tendance 4h (EMA50)`: Shows if the master trend filter is met.
    -   `RSI 1h`: Displays the 1-hour RSI for the safety filter.
    -   `ADX 15m` & `ATR % 15m`: The key indicators for the Dynamic Profile Selector.

### 📜 History
-   **Purpose**: A dedicated page for reviewing and analyzing the performance of all completed trades. Includes a "Stratégie" column to compare the profitability of 🎯, 🔥, and 🚀 setups.

### ⚙️ Settings
-   **Purpose**: Allows for complete configuration of the bot's strategy, including enabling the "Dynamic Profile Selector" and setting its thresholds.

### 🖥️ Console
-   **Purpose**: Provides a transparent, real-time view into the bot's internal operations with color-coded log levels.

---

# 🧠 Moteur de Stratégie Hybride : Le Chasseur d'Opportunités

La philosophie du bot est d'être agnostique aux conditions de marché. Il ne se limite plus à un seul type de configuration. Au lieu de cela, il scanne en permanence et simultanément le marché à la recherche de deux types d'opportunités à haute probabilité : les phases de **Précision** (calme avant la tempête) et les phases de **Momentum** (accélération explosive).

---

### **Stratégie 1 : Précision (Squeeze Macro-Micro) 🎯**

Cette stratégie vise à capturer le début d'un mouvement explosif en identifiant des périodes de compression de volatilité extrêmes sur le point de se résoudre. C'est la quintessence de l'approche "Macro-Micro".

#### **Phase 1.1 : Le Radar Macro (Qualification du Signal)**

*   **Contexte d'Analyse** : Graphique 15 minutes (15m) et 4 heures (4h).
*   **Condition 1 : Filtre de Tendance Maître (Contexte 4h)**
    *   **Outil** : Moyenne Mobile Exponentielle 50 périodes (MME50).
    *   **Règle** : Le prix de clôture actuel sur le graphique 4h doit être **STRICTEMENT SUPÉRIEUR** à la MME50. ( `Prix > MME50_4h` ).
*   **Condition 2 : Compression de Volatilité (Préparation 15m)**
    *   **Outil** : Bandes de Bollinger (BB).
    *   **Règle** : La paire doit être dans un **"Bollinger Band Squeeze"**. Ceci est défini lorsque la largeur des bandes sur la bougie de 15m *précédente* est dans le quartile inférieur (25%) de ses valeurs sur les 50 dernières périodes.
*   **Action** : Si la `Condition 1` ET la `Condition 2` sont vraies, un **signal de Précision 🎯** est identifié. Le bot s'abonne dynamiquement aux flux 1m et 5m pour chercher la validation.

#### **Phase 1.2 : Le Déclencheur Micro & Confirmation Multi-couches (Validation du Signal)**

Pour les paires avec un signal 🎯, le bot analyse chaque bougie d'une minute pour trouver le point d'entrée parfait, protégé par une série de filtres anti-piège.

*   **Contexte d'Analyse** : Graphique 1 minute (1m) et 5 minutes (5m).
*   **Condition 1 : Basculement du Momentum (L'Étincelle - 1m)**
    *   **Outil** : Moyenne Mobile Exponentielle 9 périodes (MME9).
    *   **Règle** : Une bougie de 1 minute doit **clôturer AU-DESSUS** de la MME9.
*   **Condition 2 : Confirmation par le Volume (Le Carburant - 1m & 5m)**
    *   **Règle 2a (Volume 1m)** : Le volume de la bougie de déclenchement doit être **supérieur à 1.5 fois** la moyenne du volume récent.
    *   **Règle 2b (OBV 1m & 5m)** : L'indicateur **On-Balance Volume** sur 1 minute ET sur 5 minutes doit avoir une pente ascendante.
    *   **Règle 2c (CVD 5m)** : L'indicateur **Cumulative Volume Delta** sur 5 minutes doit avoir une pente ascendante.
*   **Condition 3 : Validation Multi-Temporelle (La Confirmation Anti-Piège - 5m)**
    *   **Règle** : Après le signal 1m, le bot met le trade en **attente**. Il n'est exécuté que si la bougie de 5 minutes en cours **clôture également de manière haussière**, validant la force du mouvement.
*   **Condition 4 : Filtres de Sécurité Avancés**
    *   **Règles** : Le RSI (1h & 15m) ne doit pas être en surchauffe, la bougie de déclenchement ne doit pas avoir de grande mèche supérieure, et le prix ne doit pas être dans une phase parabolique.
*   **Action** : Si toutes ces conditions sont remplies, un **trade de type Précision 🎯** est validé.

---

### **Stratégie 2 : Momentum (Impulsion) 🔥**

Cette stratégie est conçue pour capitaliser sur des mouvements déjà en cours qui montrent des signes d'accélération soudaine. Elle est moins axée sur la préparation et plus sur la réaction rapide à la force du marché.

#### **Phase 2.1 : Détection de l'Impulsion (Qualification du Signal)**

*   **Contexte d'Analyse** : Graphique 15 minutes (15m) et 4 heures (4h).
*   **Condition 1 : Filtre de Tendance Maître (Contexte 4h)**
    *   **Règle** : Le prix doit être au-dessus de la MME50_4h.
*   **Condition 2 : Bougie d'Impulsion (L'Explosion - 15m)**
    *   **Règle** : Une bougie de 15 minutes doit clôturer avec une force significative, définie par un corps de bougie large et un volume bien supérieur à la moyenne.
*   **Action** : Si les `Conditions 1 & 2` sont vraies, un **signal de Momentum 🔥** est identifié.

#### **Phase 2.2 : Confirmation et Entrée (Validation du Signal)**

*   **Contexte d'Analyse** : Graphique 5 minutes (5m).
*   **Règle** : Le bot recherche une confirmation de continuation sur le graphique 5m. Il attend une bougie haussière qui valide la poursuite du mouvement impulsif, avec un volume soutenu.
*   **Action** : Si la continuation est confirmée, un **trade de type Momentum 🔥** est validé.

---

### **Stratégie 3 : Ignition (Anomalie de Marché) 🚀**

**Type : HAUT RISQUE / HAUTE RÉCOMPENSE**

Cette stratégie est purement expérimentale et agressive. Elle est conçue pour détecter et agir sur des anomalies de marché : des explosions soudaines et violentes de prix et de volume sur une très courte période (1 minute), qui peuvent signaler le début d'un mouvement parabolique ou une "squeeze" de liquidité.

Elle contourne délibérément la plupart des filtres de confirmation et de sécurité des stratégies `Précision` et `Momentum` pour une réactivité maximale.

#### **Phase 3.1 : Détection de l'Anomalie (Déclencheur Instantané)**

*   **Contexte d'Analyse** : Graphique 1 minute (1m).
*   **Condition 1 : Filtre de Tendance Maître (Contexte 4h)**
    *   **Règle** : Le prix doit être au-dessus de la MME50_4h. C'est le seul filtre de contexte conservé.
*   **Condition 2 : Explosion du Prix & Volume (L'Ignition - 1m)**
    *   **Règle 2a (Prix)** : Une seule bougie de 1 minute doit connaître une hausse de prix supérieure à un seuil configurable (ex: `+5%`).
    *   **Règle 2b (Volume)** : Le volume de cette même bougie doit être plusieurs fois supérieur à la moyenne récente (ex: `10x`).
*   **Action** : Si les `Conditions 1 & 2` sont vraies, un **trade de type Ignition 🚀** est immédiatement ouvert.

#### **Phase 3.2 : Gestion de Sortie Spécifique (Stop Suiveur Éclair ⚡)**

Les trades `Ignition` sont trop volatiles pour une gestion standard. Ils utilisent un mode de sortie unique :
*   **Pas de Take Profit Fixe** : L'objectif est de capturer l'intégralité du mouvement, qui est par nature imprévisible.
*   **Stop Loss Suiveur Éclair** : Un stop loss suiveur en pourcentage, très serré et réactif (ex: `-1.5%` du plus haut atteint), est activé immédiatement. Il permet de sécuriser très rapidement les gains et de couper la position dès le premier signe de retournement.

---

### **Analyse Tactique & Sélection du Profil (Le Cerveau Adaptatif Commun)**

**Cette phase est déclenchée après la validation d'un signal, qu'il soit de type 🎯 ou 🔥.** Juste avant d'ouvrir la position, si le mode dynamique est activé, le bot effectue une analyse de la "personnalité" du marché pour choisir la **stratégie de gestion de sortie** la plus appropriée.

*   **Contexte d'Analyse** : Indicateurs 15 minutes (ADX, ATR %).
*   **Matrice de Décision** :
    1.  **Le marché est-il en "Range" ?** (`ADX < Seuil_Range`) -> Sélectionner le profil **"Le Scalpeur"**.
    2.  **Sinon, le marché est-il "Hyper-Volatil" ?** (`ATR % > Seuil_Volatil`) -> Sélectionner le profil **"Le Chasseur de Volatilité"**.
    3.  **Sinon (cas par défaut)** -> Sélectionner le profil **"Le Sniper"**.
*   **Action Finale** : Exécuter l'ordre d'achat avec les paramètres du profil sélectionné et enregistrer le type de stratégie (🎯 ou 🔥) qui a déclenché l'entrée.

---

### **📈 Gestion de Trade Avancée & Entrée Intelligente**

*   **Entrées Fractionnées (Scaling In)** : Pour minimiser le risque sur les faux signaux, le bot n'entre pas avec 100% de sa position. Il initie le trade avec une fraction (ex: 50%) et n'ajoute la seconde partie que si la bougie suivante confirme la continuation du mouvement.

*   **Gestion de Sortie Progressive (Basée sur le Risque "R")** : La gestion de la sortie est dynamique, surtout pour le profil "Sniper".
    1.  **Stop Loss Initial (Basé sur l'ATR)** : Le Stop Loss est placé intelligemment en fonction de la volatilité du marché (ATR).
    2.  **Mise à Zéro du Risque (à +1R)** : Dès que le profit atteint 1 fois le risque initial (Gain = +1R), le Stop Loss est déplacé au point d'entrée, rendant le trade **sans risque**.
    3.  **Trailing Stop Adaptatif (au-delà de +1R)** : Un Trailing Stop basé sur l'ATR prend le relais. Il se **resserre** automatiquement lorsque le trade atteint des multiples de R supérieurs (ex: +1.5R), protégeant les gains de manière plus agressive tout en laissant la place au trade de respirer.

---

### **🛡️ Sécurité du Portefeuille & Survie à Long Terme (Le Capital est Sacré)**

Ces règles de sécurité ont la priorité sur toutes les stratégies d'entrée.

*   **1. Filtre de Liquidité (Carnet d'Ordres)** : Avant tout trade, le bot vérifie qu'il y a suffisamment de liquidité dans le carnet d'ordres pour éviter le slippage.

*   **2. Détection de Manipulation ("Filtre Anti-Baleine")** : Si une bougie de 1 minute montre un volume anormalement explosif (ex: >5% du volume horaire moyen), le signal est ignoré pour éviter les pièges.

*   **3. Gestion de Corrélation par Secteur** : Pour éviter la surexposition, le bot n'ouvrira qu'un nombre limité de trades à la fois sur des actifs corrélés (ex: un seul L1, un seul L2, etc.).

*   **4. Mode "Risk-Off" Automatique (Fear & Greed)** : Le bot surveille le sentiment de marché. Si le marché devient extrêmement euphorique ou paniqué, le trading est automatiquement mis en pause.

*   **5. Disjoncteur Global (Chute BTC)** : Le bot surveille en permanence le prix du Bitcoin. Si BTC subit un "dump" violent et soudain (ex: >1.5% en 5 minutes), un disjoncteur s'active, bloquant toute nouvelle entrée.

*   **6. Coupe-Circuits de Capital** :
    *   **Limite de Perte Journalière (Drawdown)** : Si le P&L total de la journée atteint un seuil négatif (ex: -3% du capital), le bot s'arrête complètement jusqu'au lendemain.
    *   **Limite de Pertes Consécutives** : Si le bot enchaîne un nombre défini de trades perdants (ex: 5), il se met en pause temporairement.